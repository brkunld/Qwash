// Gercek cihazla uctan uca seans denemesi (yalniz gelistirme).
//
//   pnpm --filter @qwash/backend demo:session -- [PROGRAM] [SURE_SN] [--stop-after SN]
//   ornek: pnpm --filter @qwash/backend demo:session -- WATER 20 --stop-after 8
//
// Kendi MQTT baglantisini ve outbox/tarama dongulerini calistirir; backend'in ayrica
// calismasi gerekmez (calisiyorsa da sorun olmaz: kilitler ve inbox cift islemeyi engeller).
// demo@qwash.local kullanicisini kullanir (pnpm db:seed).
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SessionStatus } from '../src/generated/prisma/enums';
import { MqttService } from '../src/iot/mqtt.service';
import { OutboxService } from '../src/outbox/outbox.service';
import { createPrismaClient } from '../src/prisma/prisma.service';
import { SessionService } from '../src/session/session.service';
import { WalletService } from '../src/wallet/wallet.service';

const rootEnv = resolve(__dirname, '../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const args = process.argv.slice(2).filter((a) => a !== '--');
const stopIdx = args.indexOf('--stop-after');
const stopAfterSec = stopIdx >= 0 ? Number(args[stopIdx + 1]) : undefined;
const positional = stopIdx >= 0 ? args.slice(0, stopIdx) : args;
const programCode = positional[0] ?? 'WATER';
const durationSec = Number(positional[1] ?? 20);
const BAY = process.env.DEMO_BAY ?? 'BAY-001';
const TERMINAL: SessionStatus[] = [SessionStatus.COMPLETED, SessionStatus.FAILED];

const t0 = Date.now();
const log = (msg: string) => console.warn(`[+${((Date.now() - t0) / 1000).toFixed(2)}s] ${msg}`);

async function main(): Promise<void> {
  const prisma = createPrismaClient(process.env.DATABASE_URL!);
  const wallets = new WalletService(prisma);
  const outbox = new OutboxService(prisma);
  const sessions = new SessionService(prisma, wallets, outbox);
  const mqtt = new MqttService(
    process.env.MQTT_URL ?? 'mqtt://localhost:11883',
    `qwash-demo-${randomUUID().slice(0, 8)}`,
  );

  mqtt.start(async (topic, payload) => {
    const outcome = await sessions.handleDeviceMessage(topic, payload);
    const type = (JSON.parse(payload) as { payload?: { type?: string } }).payload?.type;
    if (type !== 'HEARTBEAT') log(`cihaz: ${type} -> ${outcome}`);
    return outcome;
  });
  // Retained durum mesajinin gelmesi icin kisa bekleme (cihaz ONLINE mi?).
  await new Promise((r) => setTimeout(r, 1500));

  const timers = [
    setInterval(
      () => void outbox.publishPending(mqtt).catch((e) => log(`outbox hatasi: ${e}`)),
      200,
    ),
    setInterval(() => void sessions.sweep().catch((e) => log(`tarama hatasi: ${e}`)), 1000),
  ];

  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'demo@qwash.local' },
      include: { wallet: true },
    });
    const before = await wallets.getBalance(user.wallet!.id);
    log(`bakiye: ${before.availableKurus} kurus kullanilabilir`);

    const session = await sessions.start({
      userId: user.id,
      bayCode: BAY,
      programCode,
      durationSec,
      idempotencyKey: randomUUID(),
    });
    log(
      `seans ${session.id.slice(0, 8)} STARTING (${programCode}, ${durationSec} sn, bloke ${
        session.pricePerSecondKurus * durationSec
      } kurus)`,
    );

    let last: string = session.status;
    let stopSent = false;
    for (;;) {
      const s = await prisma.washSession.findUniqueOrThrow({ where: { id: session.id } });
      if (s.status !== last) {
        log(`durum: ${last} -> ${s.status}${s.endReason ? ` (${s.endReason})` : ''}`);
        last = s.status;
      }
      if (
        stopAfterSec !== undefined &&
        !stopSent &&
        s.status === SessionStatus.RUNNING &&
        s.startedAt &&
        Date.now() - s.startedAt.getTime() >= stopAfterSec * 1000
      ) {
        await sessions.requestStop(s.id, user.id);
        stopSent = true;
        log('STOP istendi');
      }
      if (TERMINAL.includes(s.status)) {
        const after = await wallets.getBalance(user.wallet!.id);
        log(
          `SONUC: ${s.status}, kullanilan ${s.usedSeconds ?? 0} sn, tahsil ${s.chargedKurus ?? 0n} kurus, ` +
            `bakiye ${before.balanceKurus} -> ${after.balanceKurus}, bloke ${after.holdKurus}`,
        );
        break;
      }
      if (Date.now() - t0 > (durationSec + 90) * 1000) {
        log(`ZAMAN ASIMI: seans hala ${s.status}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    // Son STOP/komutlarin gitmesi icin kisa sure.
    await new Promise((r) => setTimeout(r, 1000));
    await outbox.publishPending(mqtt).catch(() => undefined);
    timers.forEach(clearInterval);
    await mqtt.close();
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
