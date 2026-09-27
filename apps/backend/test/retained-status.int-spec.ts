import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../src/generated/prisma/client';
import { LedgerSource } from '../src/generated/prisma/enums';
import { OutboxService } from '../src/outbox/outbox.service';
import { BayUnavailableError } from '../src/session/session.errors';
import { DEFAULT_TIMINGS, SessionService } from '../src/session/session.service';
import { WalletService } from '../src/wallet/wallet.service';
import { resetDatabase, testPrisma } from './db';

const STATION = 'STATION-01';
const BAY = 'BAY-001';
const DEVICE = '4CC382C3CC1C';
const topic = (kind: string) => `qwash/station/${STATION}/bay/${BAY}/${kind}`;

/**
 * Backend acilisinda broker saklanan (retained) DEVICE_STATUS'u yeniden verir. Bu, cihazin SU AN
 * canli oldugunu kanitlamaz: kapali bir cihaz ~90 sn boyunca "baslatilabilir" gorunuyordu.
 */
describe('Saklanan (retained) durum mesaji canlilik sayilmaz (gercek PostgreSQL)', () => {
  let prisma: PrismaClient;
  let sessions: SessionService;
  let wallets: WalletService;
  let nowMs: number;
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
    nowMs = Date.parse('2026-09-27T12:00:00.000Z');
    wallets = new WalletService(prisma);
    sessions = new SessionService(prisma, wallets, new OutboxService(prisma, clock), clock);
    const station = await prisma.station.create({ data: { code: STATION, name: 'Test' } });
    const program = await prisma.washProgram.create({
      data: { stationId: station.id, code: 'WATER', name: 'Su', pricePerSecondKurus: 50 },
    });
    const bay = await prisma.bay.create({
      data: { bayCode: BAY, name: BAY, stationId: station.id },
    });
    await prisma.bayProgram.create({
      data: { bayId: bay.id, programId: program.id, relayIndex: 1 },
    });
  });

  function say(kind: string, payload: object, retained: boolean) {
    const env = { eventId: randomUUID(), deviceId: DEVICE, payload };
    return sessions.handleDeviceMessage(topic(kind), JSON.stringify(env), { retained });
  }

  async function bayProblem() {
    const bay = await prisma.bay.findUniqueOrThrow({
      where: { bayCode: BAY },
      include: { device: true },
    });
    return sessions.bayProblem(bay);
  }

  async function startSession() {
    const user = await prisma.user.create({ data: { email: `u${randomUUID()}@test.local` } });
    const { walletId } = await wallets.createWallet(user.id);
    await wallets.credit({
      walletId,
      amountKurus: 10_000,
      source: LedgerSource.CARD_TOPUP,
      idempotencyKey: randomUUID(),
    });
    return sessions.start({
      userId: user.id,
      bayCode: BAY,
      programCode: 'WATER',
      durationSec: 60,
      idempotencyKey: randomUUID(),
    });
  }

  it('cihaz kapaliyken backend yeniden acilir: saklanan ONLINE lastSeenAt i ilerletmez, peron baslatilamaz', async () => {
    await say('status', { type: 'DEVICE_STATUS', status: 'ONLINE' }, false);
    expect(await bayProblem()).toBeNull();

    // Cihaz kapandi ve backend de kapaliydi: uzun sure mesaj yok.
    advance(DEFAULT_TIMINGS.deviceStaleMs + 60_000);
    expect(await bayProblem()).toBe('DEVICE_STALE');

    // Backend acildi, broker saklanan ONLINE'i yeniden verdi (cihaz hala kapali).
    await say('status', { type: 'DEVICE_STATUS', status: 'ONLINE' }, true);
    expect(await bayProblem()).toBe('DEVICE_STALE');
    await expect(startSession()).rejects.toBeInstanceOf(BayUnavailableError);
  });

  it('cihaz gercekten canliysa ilk canli mesajla (heartbeat) peron acilir', async () => {
    await say('status', { type: 'DEVICE_STATUS', status: 'ONLINE' }, false);
    advance(DEFAULT_TIMINGS.deviceStaleMs + 60_000);
    await say('status', { type: 'DEVICE_STATUS', status: 'ONLINE' }, true);
    expect(await bayProblem()).toBe('DEVICE_STALE');

    await say('heartbeat', { type: 'HEARTBEAT', firmwareVersion: 'test' }, false);
    expect(await bayProblem()).toBeNull();
    await expect(startSession()).resolves.toMatchObject({ status: 'STARTING' });
  });

  it('cihaz hic gorulmemisse saklanan mesajla yeni kayit acilir ama canli sayilmaz', async () => {
    await say(
      'status',
      { type: 'DEVICE_STATUS', status: 'ONLINE', firmwareVersion: '0.7.1' },
      true,
    );
    const device = await prisma.device.findUniqueOrThrow({ where: { deviceId: DEVICE } });
    expect(device).toMatchObject({ reportedStatus: 'ONLINE', firmwareVersion: '0.7.1' });
    expect(device.lastSeenAt.getTime()).toBe(0);
    expect(await bayProblem()).toBe('DEVICE_STALE');
  });

  it('saklanan OFFLINE (LWT) durumu yine de uygulanir: peron cevrimdisi gorunur', async () => {
    await say('status', { type: 'DEVICE_STATUS', status: 'ONLINE' }, false);
    await say('status', { type: 'DEVICE_STATUS', status: 'OFFLINE' }, true);
    const device = await prisma.device.findUniqueOrThrow({ where: { deviceId: DEVICE } });
    expect(device.reportedStatus).toBe('OFFLINE');
    expect(await bayProblem()).toBe('DEVICE_OFFLINE');
  });
});
