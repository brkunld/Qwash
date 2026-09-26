// Yuk testi (Faz 7, ROADMAP "Eszamanli seans baslatma icin yuk testi").
//
// Amac: esazamanli yuk altinda double spending ve kayip odemeli seans olusmadigini
// gostermek (Faz 7 tamamlanma kriteri). Gercek PostgreSQL (qwash_test), gercek servis
// katmani ve baglanti havuzu; cihazlar mesajlariyla taklit edilir. Gelistirme
// veritabanina ve gercek cihaza dokunulmaz.
//
// Calistirma: pnpm --filter @qwash/backend test:load   (CI'a dahil degil; ~1 dk)
// Olcek: LOAD_USERS, LOAD_BAYS, LOAD_ROUNDS ortam degiskenleri.

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../../src/generated/prisma/client';
import type { WashSession } from '../../src/generated/prisma/client';
import { HoldStatus, LedgerSource, SessionStatus } from '../../src/generated/prisma/enums';
import { OutboxService } from '../../src/outbox/outbox.service';
import { createPrismaClient } from '../../src/prisma/prisma.service';
import { SessionService } from '../../src/session/session.service';
import { WalletService } from '../../src/wallet/wallet.service';
import { resetDatabase, testPrisma } from '../db';

const USERS = Number(process.env.LOAD_USERS ?? 200);
const BAYS = Number(process.env.LOAD_BAYS ?? 20);
const ROUNDS = Number(process.env.LOAD_ROUNDS ?? 3);
const STATION = 'LOAD-ST';
const PRICE = 5; // kurus/sn
const DURATION = 60; // sn -> bloke 300 kurus
const HOLD = PRICE * DURATION;

/** Beklenen, is kurali geregi reddedilen sonuclar. Digerleri (havuz, kilitlenme, 500) hatadir. */
const EXPECTED_REJECTIONS = new Set(['BAY_BUSY', 'BAY_UNAVAILABLE', 'INSUFFICIENT_FUNDS']);

interface Outcome {
  ms: number;
  ok: boolean;
  code: string;
  session?: WashSession;
}

describe('Yuk testi: esazamanli seans (gercek PostgreSQL)', () => {
  let prisma: PrismaClient;
  let wallets: WalletService;
  let sessions: SessionService;
  let nowMs: number;
  const report: Record<string, unknown> = {};

  const clock = () => new Date(nowMs);
  const bayCode = (i: number) => `LB-${String(i).padStart(3, '0')}`;
  const deviceOf = (i: number) => `LOADDEV${String(i).padStart(5, '0')}`;

  beforeAll(() => {
    // LOAD_POOL: uygulamadaki DB_POOL_MAX'in karsiligi (varsayilan 10).
    const pool = Number(process.env.LOAD_POOL ?? 0);
    prisma = pool ? createPrismaClient(process.env.TEST_DATABASE_URL!, pool) : testPrisma();
    report.havuz = pool || 10;
  });

  afterAll(async () => {
    process.stdout.write(`\n[YUK RAPORU]\n${JSON.stringify(report, null, 2)}\n`);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    nowMs = Date.now();
    wallets = new WalletService(prisma);
    sessions = new SessionService(prisma, wallets, new OutboxService(prisma, clock), clock);

    const station = await prisma.station.create({ data: { code: STATION, name: 'Yuk' } });
    const program = await prisma.washProgram.create({
      data: { stationId: station.id, code: 'WATER', name: 'Su', pricePerSecondKurus: PRICE },
    });
    for (let i = 0; i < BAYS; i += 1) {
      const bay = await prisma.bay.create({
        data: { bayCode: bayCode(i), name: bayCode(i), stationId: station.id },
      });
      await prisma.bayProgram.create({
        data: { bayId: bay.id, programId: program.id, relayIndex: 1 },
      });
      await device(i, { type: 'DEVICE_STATUS', status: 'ONLINE', firmwareVersion: 'load' });
    }
  });

  function device(bay: number, payload: { type: string } & Record<string, unknown>) {
    const kind =
      payload.type === 'DEVICE_STATUS'
        ? 'status'
        : ['STARTED_ACK', 'STOPPED_ACK'].includes(payload.type)
          ? 'ack'
          : 'events';
    return sessions.handleDeviceMessage(
      `qwash/station/${STATION}/bay/${bayCode(bay)}/${kind}`,
      JSON.stringify({
        deviceId: deviceOf(bay),
        stationId: STATION,
        bayId: bayCode(bay),
        eventId: randomUUID(),
        payload,
      }),
    );
  }

  async function users(count: number, balanceKurus: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const u = await prisma.user.create({
        data: { email: `load${i}-${randomUUID()}@test.local` },
      });
      const { walletId } = await wallets.createWallet(u.id);
      await wallets.credit({
        walletId,
        amountKurus: balanceKurus,
        source: LedgerSource.CASH_TOPUP,
        idempotencyKey: `load-topup:${u.id}`,
      });
      ids.push(u.id);
    }
    return ids;
  }

  async function timedStart(userId: string, bay: number): Promise<Outcome> {
    const t0 = performance.now();
    try {
      const session = await sessions.start({
        userId,
        bayCode: bayCode(bay),
        programCode: 'WATER',
        durationSec: DURATION,
        idempotencyKey: randomUUID(),
      });
      return { ms: performance.now() - t0, ok: true, code: 'OK', session };
    } catch (error) {
      return { ms: performance.now() - t0, ok: false, code: errorCode(error) };
    }
  }

  /** Para korunumu ve ledger mutabakati: yuk testinin asil hukmu. */
  async function assertInvariants(initialTotalKurus: number, expectSettled: boolean) {
    const walletsRows = await prisma.wallet.findMany();
    const sums = await prisma.$queryRaw<
      { walletId: string; type: string; total: bigint }[]
    >`SELECT "walletId", "type"::text AS type, SUM("amountKurus")::bigint AS total
      FROM "LedgerEntry" GROUP BY "walletId", "type"`;
    const byWallet = new Map<string, Record<string, bigint>>();
    for (const s of sums) {
      const m = byWallet.get(s.walletId) ?? {};
      m[s.type] = s.total;
      byWallet.set(s.walletId, m);
    }

    let totalBalance = 0n;
    for (const w of walletsRows) {
      const t = byWallet.get(w.id) ?? {};
      const g = (k: string) => t[k] ?? 0n;
      // Bakiye = giris - cikis - tahsilat; bloke = bloke - tahsil edilen blokeler - serbest.
      expect(w.balanceKurus).toBe(g('CREDIT') - g('DEBIT') - g('CAPTURE'));
      const activeHolds = await prisma.walletHold.aggregate({
        where: { walletId: w.id, status: HoldStatus.ACTIVE },
        _sum: { amountKurus: true },
      });
      expect(w.holdKurus).toBe(activeHolds._sum.amountKurus ?? 0n);
      expect(w.balanceKurus >= w.holdKurus && w.holdKurus >= 0n).toBe(true);
      totalBalance += w.balanceKurus;
    }

    // Tahsil edilen her kurus bir seansa ait ve blokeyi asmiyor.
    const captured = await prisma.walletHold.aggregate({ _sum: { capturedKurus: true } });
    const totalCaptured = captured._sum.capturedKurus ?? 0n;
    expect(totalBalance + totalCaptured).toBe(BigInt(initialTotalKurus));

    const completed = await prisma.washSession.findMany({
      where: { status: SessionStatus.COMPLETED },
      include: { hold: true },
    });
    for (const s of completed) {
      expect(s.chargedKurus).toBe(s.hold.capturedKurus);
      expect(s.hold.capturedKurus <= s.hold.amountKurus).toBe(true);
    }

    // Peron basina en fazla bir aktif seans.
    const perBay = await prisma.washSession.groupBy({
      by: ['bayId'],
      where: { status: { in: [SessionStatus.STARTING, SessionStatus.RUNNING] } },
      _count: { _all: true },
    });
    expect(perBay.every((b) => b._count._all <= 1)).toBe(true);

    if (expectSettled) {
      expect(await prisma.walletHold.count({ where: { status: HoldStatus.ACTIVE } })).toBe(0);
      expect(
        await prisma.washSession.count({
          where: { status: { notIn: [SessionStatus.COMPLETED, SessionStatus.FAILED] } },
        }),
      ).toBe(0);
    }
  }

  it('kalabalik istasyon: her peronda tek kazanan, beklenmeyen hata yok, para korunur', async () => {
    const ids = await users(USERS, 10_000);
    const initial = USERS * 10_000;
    const all: Outcome[] = [];
    const t0 = performance.now();

    for (let round = 0; round < ROUNDS; round += 1) {
      // Sahte saat her tur 60 sn ilerler; cihazlar canli oldugunu bildirmezse 90 sn sonra
      // bayat sayilir (gercekte heartbeat 10-30 sn'de bir gelir).
      await Promise.all(
        Array.from({ length: BAYS }, (_, b) =>
          device(b, { type: 'DEVICE_STATUS', status: 'ONLINE', firmwareVersion: 'load' }),
        ),
      );
      const outcomes = await Promise.all(ids.map((id, i) => timedStart(id, i % BAYS)));
      all.push(...outcomes);
      const winners = outcomes.filter((o) => o.ok);
      expect({
        round,
        winners: winners.length,
        codes: countBy(outcomes.map((o) => o.code)),
      }).toMatchObject({ winners: Math.min(BAYS, USERS) });
      expect(new Set(winners.map((w) => w.session!.bayId)).size).toBe(winners.length);
      await assertInvariants(initial, false);

      // Yasam dongusu firtinasi: ACK, cift ACK, bitis ve durdurma ayni anda.
      await Promise.all(
        winners.map(async (w) => {
          const s = w.session!;
          const bay = Number(/LB-(\d+)/.exec((await bayOf(s)).bayCode)![1]);
          const ack = { type: 'STARTED_ACK', commandId: s.startCommandId, sessionId: s.id };
          await Promise.all([
            device(bay, { ...ack, status: 'SUCCESS' }),
            device(bay, { ...ack, status: 'SUCCESS' }),
          ]);
          const used = 1 + Math.floor(Math.random() * (DURATION - 1));
          await Promise.all([
            sessions.requestStop(s.id, s.userId).catch(() => undefined),
            device(bay, {
              type: 'SESSION_ENDED',
              sessionId: s.id,
              reason: 'COMPLETED',
              remainingSec: DURATION - used,
            }),
            device(bay, {
              type: 'SESSION_ENDED',
              sessionId: s.id,
              reason: 'COMPLETED',
              remainingSec: DURATION - used,
            }),
          ]);
        }),
      );
      nowMs += DURATION * 1000;
      await assertInvariants(initial, true);
    }

    const unexpected = all.filter((o) => !o.ok && !EXPECTED_REJECTIONS.has(o.code));
    report.kalabalik = {
      kullanici: USERS,
      peron: BAYS,
      tur: ROUNDS,
      istek: all.length,
      sure_sn: round1((performance.now() - t0) / 1000),
      baslatma_ms: latency(all.map((o) => o.ms)),
      sonuclar: countBy(all.map((o) => o.code)),
    };
    expect(unexpected).toEqual([]);
  }, 300_000);

  it('cift harcama: tek seanslik bakiyeyle esazamanli 10 baslatma en fazla 1 seans acar', async () => {
    const PER_USER = Math.min(10, BAYS);
    const count = Math.max(1, Math.floor(USERS / 4));
    const ids = await users(count, HOLD); // tam bir seanslik
    const outcomes = await Promise.all(
      ids.flatMap((id, u) =>
        Array.from({ length: PER_USER }, (_, k) => timedStart(id, (u + k) % BAYS)),
      ),
    );
    const winsPerUser = new Map<string, number>();
    for (const o of outcomes.filter((x) => x.ok)) {
      winsPerUser.set(o.session!.userId, (winsPerUser.get(o.session!.userId) ?? 0) + 1);
    }
    expect([...winsPerUser.values()].every((n) => n === 1)).toBe(true);
    await assertInvariants(count * HOLD, false);

    const unexpected = outcomes.filter((o) => !o.ok && !EXPECTED_REJECTIONS.has(o.code));
    report.cift_harcama = {
      kullanici: count,
      kullanici_basina_istek: PER_USER,
      istek: outcomes.length,
      seans_acan_kullanici: winsPerUser.size,
      baslatma_ms: latency(outcomes.map((o) => o.ms)),
      sonuclar: countBy(outcomes.map((o) => o.code)),
    };
    expect(unexpected).toEqual([]);
  }, 300_000);

  it('asiri yuk: havuz dolunca istekler reddedilir (503) ama para kurallari bozulmaz', async () => {
    const OVERLOAD = Number(process.env.LOAD_OVERLOAD ?? 1500);
    const ids = await users(OVERLOAD, HOLD * 2);
    const outcomes = await Promise.all(ids.map((id, i) => timedStart(id, i % BAYS)));
    // Havuz dolu reddi (P2028 -> 503 SERVICE_BUSY) burada beklenir; digerleri yine hata.
    const unexpected = outcomes.filter(
      (o) => !o.ok && !EXPECTED_REJECTIONS.has(o.code) && o.code !== 'P2028',
    );
    const winners = outcomes.filter((o) => o.ok);
    expect(new Set(winners.map((w) => w.session!.bayId)).size).toBe(winners.length);
    await assertInvariants(OVERLOAD * HOLD * 2, false);
    report.asiri_yuk = {
      esazamanli_istek: OVERLOAD,
      peron: BAYS,
      baslatma_ms: latency(outcomes.map((o) => o.ms)),
      sonuclar: countBy(outcomes.map((o) => o.code)),
    };
    expect(unexpected).toEqual([]);
  }, 300_000);

  function bayOf(s: WashSession) {
    return prisma.bay.findUniqueOrThrow({ where: { id: s.bayId } });
  }
});

function errorCode(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof e.code === 'string') return e.code;
  return `${String(e.name)}: ${String(e.message).slice(0, 120)}`;
}

function latency(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => round1(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0);
  return { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: round1(s.at(-1) ?? 0) };
}

function countBy(xs: string[]): Record<string, number> {
  return xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
