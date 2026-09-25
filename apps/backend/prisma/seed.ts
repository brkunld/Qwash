// Gelistirme ornek verisi. Tekrar calistirilabilir (upsert).
// Fiyatlari admin belirler; buradaki degerler yalnizca baslangic ornegidir.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LedgerSource } from '../src/generated/prisma/enums';
import { createPrismaClient } from '../src/prisma/prisma.service';
import { WalletService } from '../src/wallet/wallet.service';

const rootEnv = resolve(__dirname, '../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PROGRAMS = [
  {
    code: 'WATER',
    name: 'Basincli Su',
    pricePerSecondKurus: 50,
    relayIndex: 1,
    icon: 'water-drop',
  },
  { code: 'FOAM', name: 'Aktif Kopuk', pricePerSecondKurus: 100, relayIndex: 2, icon: 'bubbles' },
  { code: 'WAX', name: 'Sicak Cila', pricePerSecondKurus: 150, relayIndex: 3, icon: 'sparkles' },
  { code: 'AIR', name: 'Hava / Kurutma', pricePerSecondKurus: 75, relayIndex: 4, icon: 'wind' },
] as const;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL tanimli degil');
  const prisma = createPrismaClient(url);
  const wallets = new WalletService(prisma);

  try {
    const station = await prisma.station.upsert({
      where: { code: 'STATION-01' },
      create: { code: 'STATION-01', name: 'Test Istasyonu' },
      update: {},
    });
    const bay = await prisma.bay.upsert({
      where: { bayCode: 'BAY-001' },
      create: { bayCode: 'BAY-001', name: 'Peron 1', stationId: station.id },
      update: {},
    });

    for (const p of PROGRAMS) {
      const program = await prisma.washProgram.upsert({
        where: { stationId_code: { stationId: station.id, code: p.code } },
        create: {
          stationId: station.id,
          code: p.code,
          name: p.name,
          icon: p.icon,
          pricePerSecondKurus: p.pricePerSecondKurus,
        },
        update: {},
      });
      await prisma.bayProgram.upsert({
        where: { bayId_programId: { bayId: bay.id, programId: program.id } },
        create: { bayId: bay.id, programId: program.id, relayIndex: p.relayIndex },
        update: {},
      });
    }

    const user = await prisma.user.upsert({
      where: { email: 'demo@qwash.local' },
      create: { email: 'demo@qwash.local', emailVerifiedAt: new Date() },
      update: {},
    });
    const wallet = await wallets.createWallet(user.id);
    // Idempotency anahtari sayesinde tekrar calistirmada bakiye iki kez yuklenmez.
    await wallets.credit({
      walletId: wallet.walletId,
      amountKurus: 15000,
      source: LedgerSource.ADJUSTMENT,
      idempotencyKey: 'seed:demo-user:initial-credit',
      note: 'Gelistirme seed bakiyesi',
    });

    const balance = await wallets.getBalance(wallet.walletId);
    console.warn(
      `Seed tamam: ${station.code} / ${bay.bayCode}, ${PROGRAMS.length} program, ` +
        `demo@qwash.local bakiye ${balance.balanceKurus} kurus`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
