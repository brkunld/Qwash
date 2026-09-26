import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../src/generated/prisma/client';
import { BayClaimStatus, LedgerSource, SessionStatus } from '../src/generated/prisma/enums';
import type { CommandEnvelope, ShowMenuCommandPayload } from '../src/iot/iot.contract';
import { OutboxService, type MessagePublisher } from '../src/outbox/outbox.service';
import {
  BayClaimService,
  DEFAULT_CLAIM_TIMINGS,
  maskEmail,
  toScreenText,
} from '../src/session/bay-claim.service';
import { BayBusyError, BayClaimedError } from '../src/session/session.errors';
import { SessionQueries } from '../src/session/session.queries';
import { SessionService } from '../src/session/session.service';
import { WalletService } from '../src/wallet/wallet.service';
import { resetDatabase, testPrisma } from './db';

const STATION = 'STATION-01';
const BAY = 'BAY-001';
const DEVICE = '4CC382C3CC1C';
const PRICE = 50; // kurus/sn
const T = (bay: string, kind: string) => `qwash/station/${STATION}/bay/${bay}/${kind}`;

class FakePublisher implements MessagePublisher {
  sent: { topic: string; envelope: CommandEnvelope }[] = [];
  async publish(topic: string, payload: string): Promise<void> {
    this.sent.push({ topic, envelope: JSON.parse(payload) as CommandEnvelope });
  }
  ofType(type: string) {
    return this.sent.filter((m) => m.envelope.payload.type === type);
  }
  lastMenu(): ShowMenuCommandPayload {
    const menus = this.ofType('SHOW_MENU');
    return menus[menus.length - 1]!.envelope.payload as ShowMenuCommandPayload;
  }
}

describe('Dokunmatik ekrandan seans (BayClaimService, gercek PostgreSQL)', () => {
  let prisma: PrismaClient;
  let wallets: WalletService;
  let outbox: OutboxService;
  let sessions: SessionService;
  let claims: BayClaimService;
  let queries: SessionQueries;
  let publisher: FakePublisher;
  let nowMs: number;
  let seq = 0;

  const clock = () => new Date(nowMs);
  const advance = (sec: number) => {
    nowMs += sec * 1000;
  };

  beforeAll(() => {
    prisma = testPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    nowMs = Date.parse('2026-09-27T10:00:00.000Z');
    wallets = new WalletService(prisma);
    outbox = new OutboxService(prisma, clock);
    sessions = new SessionService(prisma, wallets, outbox, clock);
    claims = new BayClaimService(prisma, sessions, outbox, clock);
    queries = new SessionQueries(prisma, sessions, clock);
    publisher = new FakePublisher();
    await seedStation();
    await device({ type: 'DEVICE_STATUS', status: 'ONLINE', firmwareVersion: 'test' });
  });

  // ---------------------------------------------------------------- yardimcilar

  async function seedStation(): Promise<void> {
    const station = await prisma.station.create({ data: { code: STATION, name: 'Test' } });
    const water = await prisma.washProgram.create({
      data: {
        stationId: station.id,
        code: 'WATER',
        name: 'Köpüklü Şampuan',
        pricePerSecondKurus: PRICE,
      },
    });
    const bay = await prisma.bay.create({
      data: { bayCode: BAY, name: BAY, stationId: station.id },
    });
    await prisma.bayProgram.create({ data: { bayId: bay.id, programId: water.id, relayIndex: 1 } });
  }

  async function userWith(balanceKurus: number, email?: string): Promise<string> {
    const n = ++seq;
    const user = await prisma.user.create({ data: { email: email ?? `c${n}@test.local` } });
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

  function device(payload: object, eventId?: string) {
    const type = (payload as { type: string }).type;
    const kind =
      type === 'DEVICE_STATUS'
        ? 'status'
        : type === 'STARTED_ACK' || type === 'STOPPED_ACK'
          ? 'ack'
          : 'events';
    const env = { eventId: eventId ?? randomUUID(), deviceId: DEVICE, payload };
    return sessions.handleDeviceMessage(T(BAY, kind), JSON.stringify(env));
  }

  const touchStart = (claimId: string, durationSec = 120, requestId = randomUUID()) =>
    device({ type: 'MENU_START', claimId, programCode: 'WATER', durationSec, requestId });

  async function flush() {
    await outbox.publishPending(publisher);
  }

  async function activeSession() {
    return prisma.washSession.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
  }

  async function available(userId: string): Promise<number> {
    const w = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    return Number(w.balanceKurus - w.holdKurus);
  }

  const claimRow = (id: string) => prisma.bayClaim.findUniqueOrThrow({ where: { id } });

  // ---------------------------------------------------------------- mutlu yol

  it('bagla -> ekranda menu -> dokun -> musteri hesabindan seans -> bitti -> 30 sn menu -> QR', async () => {
    const user = await userWith(20_000, 'burak@gmail.com');
    const claim = await claims.claim(user, BAY);
    expect(Date.parse(claim.expiresAt) - nowMs).toBe(DEFAULT_CLAIM_TIMINGS.idleSec * 1000);

    await flush();
    const menu = publisher.lastMenu();
    expect(publisher.ofType('SHOW_MENU')[0]!.topic).toBe(T(BAY, 'cmd'));
    expect(menu).toMatchObject({
      claimId: claim.claimId,
      afterSession: false,
      timeoutSec: DEFAULT_CLAIM_TIMINGS.idleSec,
      holder: 'BU***@GMAIL.COM',
      availableKurus: 20_000,
      programs: [{ code: 'WATER', label: 'KOPUKLU SAMPUAN', pricePerSecondKurus: PRICE }],
      durationsSec: [120, 300, 600],
    });

    // Baskasi QR'i okutsa telefondan baslatamaz, ekrani da alamaz.
    const other = await userWith(20_000);
    await expect(
      sessions.start({
        userId: other,
        bayCode: BAY,
        programCode: 'WATER',
        durationSec: 60,
        idempotencyKey: 'x',
      }),
    ).rejects.toBeInstanceOf(BayClaimedError);
    await expect(claims.claim(other, BAY)).rejects.toBeInstanceOf(BayClaimedError);
    expect((await queries.getBay(BAY)).unavailableReason).toBe('CLAIMED');

    expect(await touchStart(claim.claimId, 120)).toBe('MENU_SESSION_STARTED');
    const s = await activeSession();
    expect(s).toMatchObject({
      userId: user,
      plannedDurationSec: 120,
      status: SessionStatus.STARTING,
    });
    expect(await available(user)).toBe(20_000 - 120 * PRICE);

    await flush();
    expect(
      await device({
        type: 'STARTED_ACK',
        commandId: s.startCommandId,
        sessionId: s.id,
        status: 'SUCCESS',
      }),
    ).toBe('SESSION_RUNNING');
    advance(120);
    expect(
      await device({
        type: 'SESSION_ENDED',
        sessionId: s.id,
        reason: 'COMPLETED',
        remainingSec: 0,
      }),
    ).toBe('SESSION_COMPLETED');
    expect(await available(user)).toBe(20_000 - 120 * PRICE);

    // Seans bitti: ayni hesapla 30 sn "tekrar sec" menusu, guncel bakiyeyle.
    await flush();
    expect(publisher.lastMenu()).toMatchObject({
      claimId: claim.claimId,
      afterSession: true,
      timeoutSec: 30,
      availableKurus: 20_000 - 120 * PRICE,
    });
    expect((await claimRow(claim.claimId)).expiresAt.getTime() - nowMs).toBe(30_000);

    // 30 sn icinde secim yok: bag kapanir, ekran QR'a doner, peron herkese acilir.
    advance(29);
    expect(await claims.sweep()).toBe(0);
    advance(1);
    expect(await claims.sweep()).toBe(1);
    expect((await claimRow(claim.claimId)).status).toBe(BayClaimStatus.EXPIRED);
    await flush();
    expect(publisher.ofType('SHOW_QR')).toHaveLength(1);
    // Gercek cihaz bu arada nabiz gonderir; test saati 150 sn ilerledigi icin tazele.
    await device({ type: 'DEVICE_STATUS', status: 'ONLINE' });
    expect((await queries.getBay(BAY)).available).toBe(true);
  });

  it('30 sn icinde yeni paket secilirse ayni hesaptan ikinci seans acilir', async () => {
    const user = await userWith(50_000);
    const claim = await claims.claim(user, BAY);
    await touchStart(claim.claimId, 120);
    const first = await activeSession();
    await device({
      type: 'STARTED_ACK',
      commandId: first.startCommandId,
      sessionId: first.id,
      status: 'SUCCESS',
    });
    await device({
      type: 'SESSION_ENDED',
      sessionId: first.id,
      reason: 'COMPLETED',
      remainingSec: 0,
    });

    advance(20);
    expect(await touchStart(claim.claimId, 300)).toBe('MENU_SESSION_STARTED');
    const second = await activeSession();
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ userId: user, plannedDurationSec: 300 });
    // Seans surerken tarama bagi kapatmaz.
    advance(DEFAULT_CLAIM_TIMINGS.startWaitSec + 1);
    expect(await claims.sweep()).toBe(0);
  });

  it('ekrandaki DURDUR: cihaz kalan sureyi bildirir, yalniz kullanilan sure odenir, menu tekrar acilir', async () => {
    const user = await userWith(50_000);
    const claim = await claims.claim(user, BAY);
    await touchStart(claim.claimId, 300);
    const s = await activeSession();
    await device({
      type: 'STARTED_ACK',
      commandId: s.startCommandId,
      sessionId: s.id,
      status: 'SUCCESS',
    });
    advance(40);
    // Cihaz roleyi kendisi kapatti (SCREEN_STOP): 300 - 260 = 40 sn kullanildi.
    expect(
      await device({
        type: 'SESSION_ENDED',
        sessionId: s.id,
        reason: 'SCREEN_STOP',
        remainingSec: 260,
      }),
    ).toBe('SESSION_COMPLETED');
    const done = await prisma.washSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(done).toMatchObject({
      usedSeconds: 40,
      chargedKurus: BigInt(40 * PRICE),
      endReason: 'DEVICE_SCREEN_STOP',
    });
    expect(await available(user)).toBe(50_000 - 40 * PRICE);
    await flush();
    expect(publisher.lastMenu()).toMatchObject({ claimId: claim.claimId, afterSession: true });
  });

  it('ayni dokunus mesaji iki kez gelirse tek seans ve tek bloke olur', async () => {
    const user = await userWith(50_000);
    const claim = await claims.claim(user, BAY);
    const requestId = randomUUID();
    const eventId = randomUUID();
    const env = JSON.stringify({
      eventId,
      deviceId: DEVICE,
      payload: {
        type: 'MENU_START',
        claimId: claim.claimId,
        programCode: 'WATER',
        durationSec: 120,
        requestId,
      },
    });
    expect(await sessions.handleDeviceMessage(T(BAY, 'events'), env)).toBe('MENU_SESSION_STARTED');
    expect(await sessions.handleDeviceMessage(T(BAY, 'events'), env)).toBe('DUPLICATE_EVENT');
    // Farkli eventId ama ayni requestId (cihaz yeniden gonderdi): yine tek seans.
    expect(await touchStart(claim.claimId, 120, requestId)).toBe('MENU_SESSION_STARTED');
    expect(await prisma.washSession.count()).toBe(1);
    expect(await available(user)).toBe(50_000 - 120 * PRICE);
  });

  it('bakiye yetmezse seans acilmaz, ekrana hata gider, bag 30 sn uzar', async () => {
    const user = await userWith(1_000); // 120 sn * 50 = 6000 gerekir
    const claim = await claims.claim(user, BAY);
    expect(await touchStart(claim.claimId, 120)).toBe('MENU_START_REJECTED');
    expect(await prisma.washSession.count()).toBe(0);
    expect(await available(user)).toBe(1_000);
    await flush();
    expect(publisher.ofType('MENU_ERROR')[0]!.envelope.payload).toMatchObject({
      claimId: claim.claimId,
      message: 'BAKIYE YETERSIZ',
    });
    expect((await claimRow(claim.claimId)).expiresAt.getTime() - nowMs).toBe(30_000);
  });

  it('suresi dolmus bagla dokunus seans acmaz, ekran QR a doner', async () => {
    const user = await userWith(50_000);
    const claim = await claims.claim(user, BAY);
    advance(DEFAULT_CLAIM_TIMINGS.idleSec);
    expect(await touchStart(claim.claimId)).toBe('CLAIM_EXPIRED');
    expect(await prisma.washSession.count()).toBe(0);
    await flush();
    expect(publisher.ofType('SHOW_QR')).toHaveLength(1);
  });

  it('baska peronun cihazi bu bagla seans acamaz', async () => {
    const user = await userWith(50_000);
    const claim = await claims.claim(user, BAY);
    const env = JSON.stringify({
      eventId: randomUUID(),
      deviceId: 'OTHERDEVICE0',
      payload: {
        type: 'MENU_START',
        claimId: claim.claimId,
        programCode: 'WATER',
        durationSec: 120,
        requestId: 'r',
      },
    });
    expect(await sessions.handleDeviceMessage(T('BAY-999', 'events'), env)).toBe('BAY_MISMATCH');
    expect(await prisma.washSession.count()).toBe(0);
  });

  it('telefondan birakilinca ekran QR a doner; baskasi baglanabilir', async () => {
    const user = await userWith(50_000);
    const other = await userWith(50_000);
    const claim = await claims.claim(user, BAY);
    await claims.release(user, BAY);
    expect((await claimRow(claim.claimId)).status).toBe(BayClaimStatus.RELEASED);
    await flush();
    expect(publisher.ofType('SHOW_QR')).toHaveLength(1);
    expect(await claims.mine(user, BAY)).toBeNull();
    await expect(claims.claim(other, BAY)).resolves.toMatchObject({ bayCode: BAY });
  });

  it('ekrandaki Cikis bagi kapatir', async () => {
    const user = await userWith(50_000);
    const claim = await claims.claim(user, BAY);
    expect(await device({ type: 'MENU_EXIT', claimId: claim.claimId })).toBe('CLAIM_RELEASED');
    expect((await claimRow(claim.claimId)).status).toBe(BayClaimStatus.RELEASED);
  });

  it('ayni musteri tekrar baglanirsa ayni bag yenilenir', async () => {
    const user = await userWith(50_000);
    const a = await claims.claim(user, BAY);
    advance(60);
    const b = await claims.claim(user, BAY);
    expect(b.claimId).toBe(a.claimId);
    expect(Date.parse(b.expiresAt) - nowMs).toBe(DEFAULT_CLAIM_TIMINGS.idleSec * 1000);
  });

  it('peronda baskasinin seansi surerken baglanilamaz; suresi dolmus bag devralinir', async () => {
    const phoneUser = await userWith(50_000);
    const screenUser = await userWith(50_000);
    await sessions.start({
      userId: phoneUser,
      bayCode: BAY,
      programCode: 'WATER',
      durationSec: 60,
      idempotencyKey: 'p',
    });
    await expect(claims.claim(screenUser, BAY)).rejects.toBeInstanceOf(BayBusyError);

    await resetDatabase(prisma);
    await seedStation();
    await device({ type: 'DEVICE_STATUS', status: 'ONLINE' });
    const u1 = await userWith(50_000);
    const u2 = await userWith(50_000);
    const old = await claims.claim(u1, BAY);
    advance(DEFAULT_CLAIM_TIMINGS.idleSec); // Tarama henuz calismadi
    const fresh = await claims.claim(u2, BAY);
    expect(fresh.claimId).not.toBe(old.claimId);
    expect((await claimRow(old.claimId)).status).toBe(BayClaimStatus.EXPIRED);
  });

  it('ACK gelmezse seans iade edilir ve menu tekrar acilir', async () => {
    const user = await userWith(50_000);
    const claim = await claims.claim(user, BAY);
    await touchStart(claim.claimId, 120);
    advance(11);
    await sessions.sweep();
    expect((await activeSession()).status).toBe(SessionStatus.FAILED);
    expect(await available(user)).toBe(50_000);
    await flush();
    expect(publisher.lastMenu()).toMatchObject({ claimId: claim.claimId, afterSession: true });
  });

  it('ekran metni ASCII ve maskeli', () => {
    expect(toScreenText('Çiğ Şampuan ıslak', 20)).toBe('CIG SAMPUAN ISLAK');
    expect(maskEmail('a@x.com')).toBe('A***@X.COM');
  });
});
