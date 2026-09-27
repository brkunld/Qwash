// Yayinlanmis bir firmware surumunu bir perondaki cihaza gonderir ve sonucu izler (ADR-0013).
//
//   pnpm firmware:rollout <PERON> <surum>     (Orn: BAY-001 0.7.0)
//   pnpm firmware:rollout --status            (son 10 guncelleme)
//
// Komut outbox'a yazilir; calisan backend yayinlar ve cihazin bildirimlerini isler. Backend
// kapaliysa komut 2 dk icinde gecersiz olur. Peronda seans veya ekran bagi varken reddedilir.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { OutboxService } from '../src/outbox/outbox.service';
import { createPrismaClient } from '../src/prisma/prisma.service';
import { DeviceOpsService } from '../src/session/device-ops.service';
import { SessionService } from '../src/session/session.service';
import { WalletService } from '../src/wallet/wallet.service';

const rootEnv = resolve(__dirname, '../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const prisma = createPrismaClient(process.env.DATABASE_URL!);
  try {
    if (args[0] === '--status') {
      const rows = await prisma.firmwareUpdate.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { release: true },
      });
      for (const r of rows) {
        console.log(
          `${r.createdAt.toISOString()}  ${r.deviceId}  ${r.fromVersion ?? '?'} -> ${r.release.version}  ${r.status}${r.detail ? `  (${r.detail})` : ''}`,
        );
      }
      return;
    }
    const [bayCode, version] = args;
    if (!bayCode || !version) {
      console.error('Kullanim: firmware:rollout <PERON> <surum>  |  firmware:rollout --status');
      process.exit(2);
    }
    const outbox = new OutboxService(prisma);
    const sessions = new SessionService(prisma, new WalletService(prisma), outbox);
    const customerUrl = (process.env.CUSTOMER_APP_URL || 'http://localhost:3000').replace(
      /\/$/,
      '',
    );
    const deviceOps = new DeviceOpsService(prisma, sessions, outbox, {
      qrBase: process.env.DEVICE_QR_BASE || `${customerUrl}/b/`,
      deviceApiUrl:
        process.env.DEVICE_API_URL || process.env.API_PUBLIC_URL || 'http://localhost:3001',
    });
    const update = await deviceOps.startUpdate(bayCode, version);
    console.log(
      `Gonderildi: ${update.deviceId} ${update.fromVersion ?? '?'} -> ${version} (${update.id})`,
    );
    console.log(
      'Cihaz indirip yeniden baslayacak; yeni surumun saglikli oldugunu ~1 dk sonra bildirir.',
    );

    let last = '';
    for (let i = 0; i < 120; i++) {
      const u = await prisma.firmwareUpdate.findUniqueOrThrow({ where: { id: update.id } });
      const line = `${u.status}${u.detail ? ` (${u.detail})` : ''}`;
      if (line !== last) console.log(`  ${new Date().toLocaleTimeString('tr-TR')}  ${line}`);
      last = line;
      if (u.status === 'SUCCEEDED' || u.status === 'FAILED') {
        process.exitCode = u.status === 'SUCCEEDED' ? 0 : 1;
        return;
      }
      await sleep(3000);
    }
    console.log('6 dk icinde sonuc gelmedi; durum icin: pnpm firmware:rollout --status');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
