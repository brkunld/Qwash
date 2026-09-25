import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../src/generated/prisma/client';
import type { WashSession } from '../src/generated/prisma/client';
import {
  BayStatus,
  HoldStatus,
  LedgerSource,
  LedgerType,
  OutboxStatus,
  SessionStatus,
} from '../src/generated/prisma/enums';
import type { CommandEnvelope } from '../src/iot/iot.contract';
import { OutboxService, type MessagePublisher } from '../src/outbox/outbox.service';
import {
  BayBusyError,
  BayUnavailableError,
  InvalidDurationError,
  SessionIdempotencyConflictError,
  SessionNotFoundError,
} from '../src/session/session.errors';
import { DEFAULT_TIMINGS, SessionService } from '../src/session/session.service';
import { InsufficientFundsError } from '../src/wallet/wallet.errors';
import { WalletService } from '../src/wallet/wallet.service';
import { resetDatabase, testPrisma } from './db';

const STATION = 'STATION-01';
const BAY = 'BAY-001';
const DEVICE = '4CC382C3CC1C';
const PRICE = 50; // kurus/sn
const T = (bay: string, kind: string) => `qwash/station/${STATION}/bay/${bay}/${kind}`;

class FakePublisher implements MessagePublisher {
  sent: { topic: string; envelope: CommandEnvelope }[] = [];
  failing = false;
  async publish(topic: string, payload: string): Promise<void> {
    if (this.failing) throw new Error('broker yok');
    this.sent.push({ topic, envelope: JSON.parse(payload) as CommandEnvelope });
  }
  ofType(type: string) {
    return this.sent.filter((m) => m.envelope.payload.type === type);
  }
}

describe('SessionService (gercek PostgreSQL)', () => {
  let prisma: PrismaClient;
  let wallets: WalletService;
  let outbox: OutboxService;
  let sessions: SessionService;
  let publisher: FakePublisher;
  let nowMs: number;
  let seq = 0;

  const clock = () => new Date(nowMs);
  const advance = (ms: number) => {
    nowMs += ms;
  };

  beforeAll(() => {
    prisma = testPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    nowMs = Date.parse('2026-09-25T10:00:00.000Z');
    wallets = new WalletService(prisma);
    outbox = new OutboxService(prisma, clock);
    sessions = new SessionService(prisma, wallets, outbox, clock);
    publisher = new FakePublisher();
    await seedStation(BAY);
    await deviceSays(BAY, { type: 'DEVICE_STATUS', status: 'ONLINE', firmwareVersion: 'test' });
  });

  // ---------------------------------------------------------------- yardimcilar

  async function seedStation(bayCode: string): Promise<void> {
    const station = await prisma.station.upsert({
      where: { code: STATION },
      create: { code: STATION, name: 'Test' },
      update: {},
    });
    const program = await prisma.washProgram.upsert({
      where: { stationId_code: { stationId: station.id, code: 'WATER' } },
      create: { stationId: station.id, code: 'WATER', name: 'Su', pricePerSecondKurus: PRICE },
      update: {},
    });
    const bay = await prisma.bay.create({
      data: { bayCode, name: bayCode, stationId: station.id },
    });
    await prisma.bayProgram.create({
      data: { bayId: bay.id, programId: program.id, relayIndex: 1 },
    });
  }

  async function userWith(balanceKurus: number): Promise<string> {
    const n = ++seq; // Eszamanli cagrilarda her kullanici kendi numarasini tutar.
    const user = await prisma.user.create({ data: { email: `s${n}@test.local` } });
    const { walletId } = await wallets.createWallet(user.id);
    if (balanceKurus > 0) {
      await wallets.credit({
        walletId,
        amountKurus: balanceKurus,
        source: LedgerSource.CARD_TOPUP,
        idempotencyKey: `topup-${n}`,
      });
    }
    return user.id;
  }

  function start(userId: string, durationSec = 60, key = randomUUID(), bayCode = BAY) {
    return sessions.start({
      userId,
      bayCode,
      programCode: 'WATER',
      durationSec,
      idempotencyKey: key,
    });
  }

  function deviceSays(
    bayCode: string,
    payload: object,
    eventId?: string | null,
    deviceId = DEVICE,
  ) {
    const type = (payload as { type: string }).type;
    const kind =
      type === 'DEVICE_STATUS'
        ? 'status'
        : type === 'HEARTBEAT'
          ? 'heartbeat'
          : ['STARTED_ACK', 'STOPPED_ACK'].includes(type)
            ? 'ack'
            : 'events';
    const env: Record<string, unknown> = { deviceId, stationId: STATION, bayId: bayCode, payload };
    if (eventId !== null) env.eventId = eventId ?? randomUUID();
    return sessions.handleDeviceMessage(T(bayCode, kind), JSON.stringify(env));
  }

  const ack = (s: WashSession, status = 'SUCCESS', extra: object = {}, eventId?: string) =>
    deviceSays(
      BAY,
      { type: 'STARTED_ACK', commandId: s.startCommandId, sessionId: s.id, status, ...extra },
      eventId,
    );

  const ended = (s: WashSession, remainingSec: number, eventId?: string, bayCode = BAY) =>
    deviceSays(
      bayCode,
      { type: 'SESSION_ENDED', sessionId: s.id, reason: 'COMPLETED', remainingSec },
      eventId,
    );

  const reload = (s: WashSession) => prisma.washSession.findUniqueOrThrow({ where: { id: s.id } });

  async function available(userId: string): Promise<number> {
    const w = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    return Number(w.balanceKurus - w.holdKurus);
  }

  async function balance(userId: string): Promise<number> {
    const w = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    return Number(w.balanceKurus);
  }

  async function holdOf(s: WashSession) {
    return prisma.walletHold.findUniqueOrThrow({ where: { id: s.holdId } });
  }

  async function bayStatus(bayCode = BAY) {
    return (await prisma.bay.findUniqueOrThrow({ where: { bayCode } })).status;
  }

  // ---------------------------------------------------------------- mutlu yol

  it('baslat -> START yayinlanir -> ACK -> bitti: kullanilan sure tahsil edilir', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);

    expect(s.status).toBe(SessionStatus.STARTING);
    expect(await available(user)).toBe(10_000 - 60 * PRICE);
    expect(await bayStatus()).toBe(BayStatus.WAITING);

    await outbox.publishPending(publisher);
    const [cmd] = publisher.ofType('START');
    expect(cmd!.topic).toBe(T(BAY, 'cmd'));
    expect(cmd!.envelope).toMatchObject({
      commandId: s.startCommandId,
      sessionId: s.id,
      deviceId: DEVICE,
      payload: { type: 'START', program: 'WATER', relayIndex: 1, durationSec: 60 },
    });
    expect(Date.parse(cmd!.envelope.expiresAt!) - nowMs).toBe(DEFAULT_TIMINGS.ackTimeoutMs);

    expect(await ack(s)).toBe('SESSION_RUNNING');
    expect((await reload(s)).status).toBe(SessionStatus.RUNNING);
    expect(await bayStatus()).toBe(BayStatus.RUNNING);

    expect(await ended(s, 0)).toBe('SESSION_COMPLETED');
    const done = await reload(s);
    expect(done).toMatchObject({
      status: SessionStatus.COMPLETED,
      usedSeconds: 60,
      chargedKurus: 3000n,
    });
    expect(await balance(user)).toBe(7_000);
    expect(await available(user)).toBe(7_000);
    expect((await holdOf(s)).status).toBe(HoldStatus.CAPTURED);
    expect(await bayStatus()).toBe(BayStatus.IDLE);

    const reasons = await prisma.sessionTransition.findMany({
      where: { sessionId: s.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(reasons.map((t) => t.toState)).toEqual([
      SessionStatus.STARTING,
      SessionStatus.RUNNING,
      SessionStatus.COMPLETED,
    ]);
  });

  it('erken STOP: yalnizca kullanilan saniye tahsil edilir, kalan iade', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    await ack(s);

    await sessions.requestStop(s.id, user);
    await outbox.publishPending(publisher);
    const [stop] = publisher.ofType('STOP');
    expect(stop!.envelope).toMatchObject({
      sessionId: s.id,
      payload: { type: 'STOP', reason: 'USER_STOP' },
    });

    expect(await ended(s, 40)).toBe('SESSION_COMPLETED');
    expect(await reload(s)).toMatchObject({ usedSeconds: 20, chargedKurus: 1000n });
    expect(await balance(user)).toBe(9_000);
    expect(await available(user)).toBe(9_000);
  });

  it('hic kullanilmadan biten seans: bloke tamamen iade (tahsilat 0)', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    await ack(s);
    await ended(s, 60);
    expect(await reload(s)).toMatchObject({ status: SessionStatus.COMPLETED, chargedKurus: 0n });
    expect((await holdOf(s)).status).toBe(HoldStatus.RELEASED);
    expect(await balance(user)).toBe(10_000);
  });

  // ---------------------------------------------------------------- zaman asimi / gec ACK

  it('ACK 5 sn icinde gelmezse: FAILED, para iade, tedbiren STOP, peron ERROR', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);

    advance(DEFAULT_TIMINGS.ackTimeoutMs - 1);
    expect((await sessions.sweep()).ackTimeouts).toBe(0);

    advance(1);
    expect((await sessions.sweep()).ackTimeouts).toBe(1);
    expect(await reload(s)).toMatchObject({
      status: SessionStatus.FAILED,
      endReason: 'ACK_TIMEOUT',
    });
    expect(await available(user)).toBe(10_000);
    expect((await holdOf(s)).status).toBe(HoldStatus.RELEASED);
    expect(await bayStatus()).toBe(BayStatus.ERROR);

    await outbox.publishPending(publisher);
    // START suresi doldugu icin yayinlanmadi; yalnizca STOP gitti.
    expect(publisher.ofType('START')).toHaveLength(0);
    expect(publisher.ofType('STOP')[0]!.envelope).toMatchObject({
      sessionId: s.id,
      payload: { reason: 'ACK_TIMEOUT' },
    });

    // Tarama tekrar calisinca ayni seansi ikinci kez islemez.
    expect((await sessions.sweep()).ackTimeouts).toBe(0);
  });

  it('gec ACK: iade edilmis seansa STARTED_ACK gelirse STOP gonderilir, para hareket etmez', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    advance(DEFAULT_TIMINGS.ackTimeoutMs);
    await sessions.sweep();
    await outbox.publishPending(publisher);
    publisher.sent = [];

    expect(await ack(s)).toBe('LATE_ACK_STOP_SENT');
    await outbox.publishPending(publisher);
    expect(publisher.ofType('STOP')[0]!.envelope.payload).toMatchObject({ reason: 'LATE_ACK' });
    expect((await reload(s)).status).toBe(SessionStatus.FAILED);
    expect(await balance(user)).toBe(10_000);
    expect(await available(user)).toBe(10_000);

    // Cihaz STOP ile kapanip bitisi bildirirse: tahsil edilemez, isaretlenir.
    expect(await ended(s, 50)).toBe('UNPAID_RUN');
    expect(await balance(user)).toBe(10_000);
    const flagged = await prisma.sessionTransition.findFirst({
      where: { sessionId: s.id, reason: 'UNPAID_RUN_REPORTED' },
    });
    expect(flagged?.detail).toMatchObject({ usedSeconds: 10 });
  });

  it('ACK suresi dolduktan sonra ama taramadan once gelen ACK kabul edilir (para hala blokede)', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    advance(DEFAULT_TIMINGS.ackTimeoutMs + 500);
    expect(await ack(s)).toBe('SESSION_RUNNING');
    expect((await sessions.sweep()).ackTimeouts).toBe(0);
    expect((await reload(s)).status).toBe(SessionStatus.RUNNING);
  });

  it('ACK ile zaman asimi taramasi yarisirsa: ya RUNNING+bloke ya FAILED+iade, asla karisik degil', async () => {
    for (let i = 0; i < 8; i += 1) {
      const user = await userWith(10_000);
      const s = await start(user, 60, randomUUID());
      advance(DEFAULT_TIMINGS.ackTimeoutMs);
      await Promise.all([ack(s), sessions.sweep()]);

      const after = await reload(s);
      const hold = await holdOf(s);
      if (after.status === SessionStatus.RUNNING) {
        expect(hold.status).toBe(HoldStatus.ACTIVE);
      } else {
        expect(after.status).toBe(SessionStatus.FAILED);
        expect(hold.status).toBe(HoldStatus.RELEASED);
      }
      // Sonraki tur icin peronu bosalt.
      if (after.status === SessionStatus.RUNNING) await ended(s, 60);
    }
  });

  it('cihaz START i reddederse (BUSY/EXPIRED...): FAILED ve iade', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    expect(await ack(s, 'REJECTED', { reason: 'EXPIRED' })).toBe('SESSION_FAILED');
    expect(await reload(s)).toMatchObject({
      status: SessionStatus.FAILED,
      endReason: 'DEVICE_REJECTED_EXPIRED',
    });
    expect(await available(user)).toBe(10_000);
    expect(await bayStatus()).toBe(BayStatus.IDLE);
  });

  // ---------------------------------------------------------------- idempotency

  it('ayni eventId tekrar gelirse yok sayilir; farkli eventId ile tekrar da cift tahsilat yapmaz', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    const ackId = randomUUID();
    expect(await ack(s, 'SUCCESS', {}, ackId)).toBe('SESSION_RUNNING');
    expect(await ack(s, 'SUCCESS', {}, ackId)).toBe('DUPLICATE_EVENT');
    expect(await ack(s)).toBe('NO_OP');

    const endId = randomUUID();
    expect(await ended(s, 0, endId)).toBe('SESSION_COMPLETED');
    expect(await ended(s, 0, endId)).toBe('DUPLICATE_EVENT');
    expect(await ended(s, 30)).toBe('NO_OP');
    expect(
      await deviceSays(BAY, {
        type: 'STOPPED_ACK',
        commandId: 'x',
        sessionId: s.id,
        status: 'SUCCESS',
        remainingSec: 0,
      }),
    ).toBe('NO_OP');

    expect(await balance(user)).toBe(7_000);
    const captures = await prisma.ledgerEntry.count({
      where: { holdId: s.holdId, type: LedgerType.CAPTURE },
    });
    expect(captures).toBe(1);
  });

  it('SESSION_ENDED kaybolursa STOPPED_ACK seansi kapatir', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    await ack(s);
    const outcome = await deviceSays(BAY, {
      type: 'STOPPED_ACK',
      commandId: randomUUID(),
      sessionId: s.id,
      status: 'SUCCESS',
      remainingSec: 30,
    });
    expect(outcome).toBe('SESSION_COMPLETED');
    expect(await reload(s)).toMatchObject({ usedSeconds: 30, endReason: 'DEVICE_STOPPED' });
  });

  it('ayni istek anahtari: tek seans, tek bloke (sirali ve eszamanli)', async () => {
    const user = await userWith(100_000);
    const key = randomUUID();
    const a = await start(user, 60, key);
    const b = await start(user, 60, key);
    expect(b.id).toBe(a.id);

    // Peronu bosalt, sonra ayni yeni anahtarla 5 eszamanli istek.
    await ack(a);
    await ended(a, 60);
    const key2 = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => start(user, 30, key2)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await prisma.walletHold.count({ where: { idempotencyKey: `session:${key2}` } })).toBe(1);
  });

  it('ayni anahtar farkli parametrelerle kullanilirsa reddedilir', async () => {
    const user = await userWith(100_000);
    const key = randomUUID();
    await start(user, 60, key);
    await expect(start(user, 90, key)).rejects.toBeInstanceOf(SessionIdempotencyConflictError);
  });

  // ---------------------------------------------------------------- eszamanlilik / kurallar

  it('ayni perona 10 eszamanli baslat: yalnizca biri basarili, digerlerinin parasi bloke edilmez', async () => {
    const users = await Promise.all(Array.from({ length: 10 }, () => userWith(10_000)));
    const results = await Promise.allSettled(users.map((u) => start(u, 60)));

    const ok = results.filter((r) => r.status === 'fulfilled');
    const busy = results.filter(
      (r) => r.status === 'rejected' && (r as PromiseRejectedResult).reason instanceof BayBusyError,
    );
    expect(ok).toHaveLength(1);
    expect(busy).toHaveLength(9);
    expect(await prisma.walletHold.count()).toBe(1);
    const totalHold = await prisma.wallet.aggregate({ _sum: { holdKurus: true } });
    expect(totalHold._sum.holdKurus).toBe(3000n);
  });

  it('yetersiz bakiye: seans ve komut olusmaz', async () => {
    const user = await userWith(100);
    await expect(start(user, 60)).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await prisma.washSession.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect(await bayStatus()).toBe(BayStatus.IDLE);
  });

  it('gecersiz sure reddedilir', async () => {
    const user = await userWith(1_000_000);
    await expect(start(user, 0)).rejects.toBeInstanceOf(InvalidDurationError);
    await expect(start(user, 3601)).rejects.toBeInstanceOf(InvalidDurationError);
  });

  it('cihaz cevrimdisi (LWT) veya uzun suredir sessizse peron kullanilamaz', async () => {
    const user = await userWith(100_000);
    await deviceSays(BAY, { type: 'DEVICE_STATUS', status: 'OFFLINE' }, null);
    await expect(start(user, 60)).rejects.toBeInstanceOf(BayUnavailableError);
    expect(await bayStatus()).toBe(BayStatus.OFFLINE);

    await deviceSays(BAY, { type: 'DEVICE_STATUS', status: 'ONLINE' });
    expect(await bayStatus()).toBe(BayStatus.IDLE);
    advance(DEFAULT_TIMINGS.deviceStaleMs + 1);
    await expect(start(user, 60)).rejects.toMatchObject({
      message: expect.stringContaining('DEVICE_STALE'),
    });

    await deviceSays(BAY, { type: 'HEARTBEAT', sessionActive: false });
    await expect(start(user, 60)).resolves.toMatchObject({ status: SessionStatus.STARTING });
  });

  it('baska peronun cihazi bu seansi degistiremez', async () => {
    await seedStation('BAY-002');
    await deviceSays(
      'BAY-002',
      { type: 'DEVICE_STATUS', status: 'ONLINE' },
      undefined,
      'AABBCCDDEEFF',
    );
    const user = await userWith(10_000);
    const s = await start(user, 60);
    await ack(s);

    expect(await ended(s, 0, undefined, 'BAY-002')).toBe('BAY_MISMATCH');
    expect((await reload(s)).status).toBe(SessionStatus.RUNNING);
    expect((await holdOf(s)).status).toBe(HoldStatus.ACTIVE);
  });

  it('peron baska cihaza bagliyken yeni bir cihaz perona baglanamaz', async () => {
    await deviceSays(BAY, { type: 'DEVICE_STATUS', status: 'ONLINE' }, undefined, 'FFFFFFFFFFFF');
    const bay = await prisma.bay.findUniqueOrThrow({
      where: { bayCode: BAY },
      include: { device: true },
    });
    expect(bay.device?.deviceId).toBe(DEVICE);
    const intruder = await prisma.device.findUniqueOrThrow({ where: { deviceId: 'FFFFFFFFFFFF' } });
    expect(intruder.bayId).toBeNull();
  });

  it('baskasinin seansini durduramaz', async () => {
    const owner = await userWith(10_000);
    const other = await userWith(10_000);
    const s = await start(owner, 60);
    await expect(sessions.requestStop(s.id, other)).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  // ---------------------------------------------------------------- mutabakat

  it('bitis bildirilmezse RECONCILING; cihaz donup bitirince kapanir', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    await ack(s);

    advance((60 + DEFAULT_TIMINGS.endGraceSec) * 1000 - 1);
    expect((await sessions.sweep()).reconciling).toBe(0);
    advance(1);
    expect((await sessions.sweep()).reconciling).toBe(1);
    expect((await reload(s)).status).toBe(SessionStatus.RECONCILING);
    expect((await holdOf(s)).status).toBe(HoldStatus.ACTIVE);

    // Peron RECONCILING iken baska seans acilamaz (cihazin durumu belirsiz).
    const other = await userWith(10_000);
    await expect(start(other, 60)).rejects.toBeInstanceOf(BayBusyError);

    expect(
      await deviceSays(BAY, {
        type: 'SESSION_RECOVERED',
        sessionId: s.id,
        detail: 'RESET_REASON_1',
        remainingSec: 20,
      }),
    ).toBe('RECOVERY_RECORDED');
    expect(await ended(s, 0)).toBe('SESSION_COMPLETED');
    expect(await reload(s)).toMatchObject({ status: SessionStatus.COMPLETED, usedSeconds: 60 });
  });

  // ---------------------------------------------------------------- cihazi kaybolan seans

  const heartbeat = (s: WashSession, remainingSec: number, bayCode = BAY, deviceId = DEVICE) =>
    deviceSays(
      bayCode,
      { type: 'HEARTBEAT', sessionActive: true, sessionId: s.id, remainingSec },
      undefined,
      deviceId,
    );

  /** RUNNING seansi RECONCILING'e, sonra otomatik kapanma esigine getirir. */
  async function loseDevice(s: WashSession, planned = 60) {
    advance((planned + DEFAULT_TIMINGS.endGraceSec) * 1000);
    expect((await sessions.sweep()).reconciling).toBe(1);
  }

  it('cihaz 30 dk donmezse: yalnizca kanitlanmis sure tahsil, kalan iade, incelemeye isaretli', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    await ack(s);
    await heartbeat(s, 50); // 10 sn kullanildi
    await heartbeat(s, 38); // 22 sn kullanildi
    await heartbeat(s, 45); // Sirasi karismis eski heartbeat: kanit geri gitmez
    expect((await reload(s)).provenUsedSec).toBe(22);

    await loseDevice(s);
    advance(DEFAULT_TIMINGS.reconcileTimeoutMs - 1);
    expect((await sessions.sweep()).autoClosed).toBe(0);
    advance(1);
    expect((await sessions.sweep()).autoClosed).toBe(1);

    expect(await reload(s)).toMatchObject({
      status: SessionStatus.COMPLETED,
      usedSeconds: 22,
      chargedKurus: 1100n,
      endReason: 'DEVICE_LOST',
      needsReview: true,
    });
    expect(await balance(user)).toBe(10_000 - 1100);
    expect(await available(user)).toBe(10_000 - 1100);
    expect(await bayStatus()).toBe(BayStatus.ERROR);
    expect((await sessions.sweep()).autoClosed).toBe(0);
  });

  it('hic kanit yoksa (heartbeat gelmeden kayboldu): tamami iade', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    await ack(s);
    await loseDevice(s);
    advance(DEFAULT_TIMINGS.reconcileTimeoutMs);
    await sessions.sweep();
    expect(await reload(s)).toMatchObject({ usedSeconds: 0, chargedKurus: 0n, needsReview: true });
    expect((await holdOf(s)).status).toBe(HoldStatus.RELEASED);
    expect(await balance(user)).toBe(10_000);
  });

  it('cihaz 30 dk icinde donerse gercek sureyle kapanir, otomatik kapatma olmaz', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    await ack(s);
    await heartbeat(s, 50);
    await loseDevice(s);
    advance(DEFAULT_TIMINGS.reconcileTimeoutMs / 2);
    expect(await ended(s, 0)).toBe('SESSION_COMPLETED');
    advance(DEFAULT_TIMINGS.reconcileTimeoutMs);
    expect((await sessions.sweep()).autoClosed).toBe(0);
    expect(await reload(s)).toMatchObject({
      usedSeconds: 60,
      chargedKurus: 3000n,
      needsReview: false,
    });
  });

  it('otomatik kapatmadan sonra cihaz donerse: gercek sure kaydedilir, para hareket etmez, bir kez', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    await ack(s);
    await heartbeat(s, 40);
    await loseDevice(s);
    advance(DEFAULT_TIMINGS.reconcileTimeoutMs);
    await sessions.sweep();
    const charged = await balance(user);

    expect(await ended(s, 0)).toBe('LATE_END_RECORDED');
    expect(await ended(s, 0)).toBe('NO_OP'); // Firmware her baglantida tekrar gonderir
    expect(await balance(user)).toBe(charged);
    const late = await prisma.sessionTransition.findMany({
      where: { sessionId: s.id, reason: 'LATE_END_AFTER_AUTO_CLOSE' },
    });
    expect(late).toHaveLength(1);
    expect(late[0]!.detail).toMatchObject({ reportedUsedSeconds: 60, chargedUsedSeconds: 20 });
  });

  it('iade edilmis seansa tekrar tekrar gelen bitis yalnizca bir kez isaretlenir', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    advance(DEFAULT_TIMINGS.ackTimeoutMs);
    await sessions.sweep();
    expect(await ended(s, 30)).toBe('UNPAID_RUN');
    expect(await ended(s, 30)).toBe('NO_OP');
    expect(
      await prisma.sessionTransition.count({
        where: { sessionId: s.id, reason: 'UNPAID_RUN_REPORTED' },
      }),
    ).toBe(1);
    expect((await reload(s)).needsReview).toBe(true);
  });

  it('baska perona bagli cihazin heartbeat i kanit sayilmaz', async () => {
    await seedStation('BAY-002');
    await deviceSays(
      'BAY-002',
      { type: 'DEVICE_STATUS', status: 'ONLINE' },
      undefined,
      'AABBCCDDEEFF',
    );
    const user = await userWith(10_000);
    const s = await start(user, 60);
    await ack(s);
    await heartbeat(s, 0, 'BAY-002', 'AABBCCDDEEFF');
    expect((await reload(s)).provenUsedSec).toBe(0);
    await heartbeat(s, 30);
    expect((await reload(s)).provenUsedSec).toBe(30);
  });

  it('SESSION_RECOVERED kalan sureyi kanit olarak isler', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    await ack(s);
    await deviceSays(BAY, { type: 'SESSION_RECOVERED', sessionId: s.id, remainingSec: 15 });
    expect((await reload(s)).provenUsedSec).toBe(45);
  });

  // ---------------------------------------------------------------- outbox

  it('broker yoksa komut bekler, broker gelince yayinlanir', async () => {
    const user = await userWith(10_000);
    await start(user, 60);
    publisher.failing = true;
    expect(await outbox.publishPending(publisher)).toMatchObject({ published: 0, failed: 1 });
    const pending = await prisma.outboxEvent.findFirstOrThrow();
    expect(pending).toMatchObject({ status: OutboxStatus.PENDING, attempts: 1 });

    publisher.failing = false;
    expect(await outbox.publishPending(publisher)).toMatchObject({ published: 1 });
    expect(publisher.ofType('START')).toHaveLength(1);
  });

  it('eszamanli iki yayinci ayni komutu iki kez gondermez', async () => {
    const users = await Promise.all([userWith(10_000)]);
    await start(users[0]!, 60);
    const p2 = new FakePublisher();
    await Promise.all([outbox.publishPending(publisher), outbox.publishPending(p2)]);
    expect(publisher.sent.length + p2.sent.length).toBe(1);
  });

  // ---------------------------------------------------------------- ariza enjeksiyonu

  it('STARTED_ACK kaybolur ama cihaz calisip biterse: gercek sureyle kapanir, sonra gelen ACK etkisiz', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    // ACK hic gelmedi; zaman asimi taramasindan once cihazin bitis bildirimi ulasti.
    expect(await ended(s, 20)).toBe('SESSION_COMPLETED');
    expect(await reload(s)).toMatchObject({
      status: SessionStatus.COMPLETED,
      usedSeconds: 40,
      chargedKurus: 2000n,
    });
    expect(await balance(user)).toBe(8_000);
    expect(await available(user)).toBe(8_000);
    expect(await bayStatus()).toBe(BayStatus.IDLE);

    // Kaybolan ACK gec gelir, tarama da calisir: hicbiri seansi ya da parayi degistirmez.
    expect(await ack(s)).toBe('NO_OP');
    advance(DEFAULT_TIMINGS.ackTimeoutMs);
    expect((await sessions.sweep()).ackTimeouts).toBe(0);
    expect((await reload(s)).status).toBe(SessionStatus.COMPLETED);
    expect(await balance(user)).toBe(8_000);
    await outbox.publishPending(publisher);
    expect(publisher.ofType('STOP')).toHaveLength(0);
  });

  it('ayni ACK farkli eventId ile eszamanli gelirse seans bir kez RUNNING olur', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => ack(s)));
    expect(outcomes.filter((o) => o === 'SESSION_RUNNING')).toHaveLength(1);
    expect(outcomes.filter((o) => o !== 'SESSION_RUNNING').every((o) => o === 'NO_OP')).toBe(true);
    expect(
      await prisma.sessionTransition.count({
        where: { sessionId: s.id, toState: SessionStatus.RUNNING },
      }),
    ).toBe(1);
    expect((await holdOf(s)).status).toBe(HoldStatus.ACTIVE);
  });

  it('ayni ACK ayni eventId ile eszamanli gelirse yalnizca biri islenir', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    const id = randomUUID();
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => ack(s, 'SUCCESS', {}, id)));
    expect(outcomes.filter((o) => o === 'SESSION_RUNNING')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'DUPLICATE_EVENT')).toHaveLength(4);
  });

  it('eszamanli bitis bildirimleri (SESSION_ENDED x3 + STOPPED_ACK) tek tahsilat yapar', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    await ack(s);
    const outcomes = await Promise.all([
      ended(s, 30),
      ended(s, 30),
      ended(s, 30),
      deviceSays(BAY, {
        type: 'STOPPED_ACK',
        commandId: randomUUID(),
        sessionId: s.id,
        status: 'SUCCESS',
        remainingSec: 30,
      }),
    ]);
    expect(outcomes.filter((o) => o === 'SESSION_COMPLETED')).toHaveLength(1);
    expect(
      await prisma.ledgerEntry.count({ where: { holdId: s.holdId, type: LedgerType.CAPTURE } }),
    ).toBe(1);
    expect(await reload(s)).toMatchObject({ usedSeconds: 30, chargedKurus: 1500n });
    expect(await balance(user)).toBe(8_500);
    expect(await available(user)).toBe(8_500);
  });

  it('backend yeniden baslarsa: bekleyen START yeni sureçte gider, ACK ve tekrarlari dogru islenir', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    const ackId = randomUUID();

    // Eski surec START'i yayinlayamadan oldu; durum yalnizca veritabaninda.
    const outbox2 = new OutboxService(prisma, clock);
    const sessions2 = new SessionService(prisma, wallets, outbox2, clock);
    advance(2_000);
    await outbox2.publishPending(publisher);
    expect(publisher.ofType('START')).toHaveLength(1);
    expect(publisher.ofType('START')[0]!.envelope.commandId).toBe(s.startCommandId);

    const envelope = (payload: object) =>
      JSON.stringify({ eventId: ackId, deviceId: DEVICE, stationId: STATION, bayId: BAY, payload });
    const ackMsg = envelope({
      type: 'STARTED_ACK',
      commandId: s.startCommandId,
      sessionId: s.id,
      status: 'SUCCESS',
    });
    expect(await sessions2.handleDeviceMessage(T(BAY, 'ack'), ackMsg)).toBe('SESSION_RUNNING');
    // Broker (clean: false) ayni mesaji yeniden baslayan diger surece de teslim eder.
    expect(await sessions.handleDeviceMessage(T(BAY, 'ack'), ackMsg)).toBe('DUPLICATE_EVENT');

    await sessions2.handleDeviceMessage(
      T(BAY, 'events'),
      JSON.stringify({
        eventId: randomUUID(),
        deviceId: DEVICE,
        stationId: STATION,
        bayId: BAY,
        payload: { type: 'SESSION_ENDED', sessionId: s.id, reason: 'COMPLETED', remainingSec: 0 },
      }),
    );
    expect(await reload(s)).toMatchObject({ status: SessionStatus.COMPLETED, chargedKurus: 3000n });
    expect(await balance(user)).toBe(7_000);
  });

  it('yayindan sonra "gonderildi" yazilamadan cokerse: komut ayni commandId ile tekrar gider', async () => {
    const user = await userWith(10_000);
    const s = await start(user, 60);
    await outbox.publishPending(publisher);
    // Cokme benzetimi: broker mesaji aldi ama kayit PENDING kaldi.
    await prisma.outboxEvent.updateMany({
      data: { status: OutboxStatus.PENDING, publishedAt: null },
    });
    await outbox.publishPending(publisher);

    const starts = publisher.ofType('START');
    expect(starts).toHaveLength(2);
    // Cihaz tekrari commandId ile ayirt eder (firmware idempotency); ikisi birebir ayni olmali.
    expect(starts[1]!.envelope).toEqual(starts[0]!.envelope);
    expect(starts[0]!.envelope.commandId).toBe(s.startCommandId);

    // Cihaz iki komut icin de ACK gonderse bile tek seans, tek bloke.
    expect(await ack(s)).toBe('SESSION_RUNNING');
    expect(await ack(s)).toBe('NO_OP');
    expect(await available(user)).toBe(10_000 - 60 * PRICE);
  });

  it('gecersiz cihaz mesajlari sistemi bozmaz', async () => {
    expect(await sessions.handleDeviceMessage('baska/topic', '{}')).toBe('IGNORED_TOPIC');
    expect(await sessions.handleDeviceMessage(T(BAY, 'ack'), 'bu json degil')).toBe('INVALID_JSON');
    expect(await sessions.handleDeviceMessage(T(BAY, 'ack'), '{"payload":{"type":"NOPE"}}')).toBe(
      'INVALID_SCHEMA',
    );
    expect(
      await deviceSays(BAY, {
        type: 'STARTED_ACK',
        commandId: randomUUID(),
        sessionId: 'x',
        status: 'SUCCESS',
      }),
    ).toBe('UNKNOWN_SESSION');
  });
});
