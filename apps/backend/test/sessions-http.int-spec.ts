import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { SOCKET_EVENTS, type SessionView } from '@qwash/contracts';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { AccessTokenGuard } from '../src/auth/auth.guard';
import { AuthService } from '../src/auth/auth.service';
import { CapturingMailer } from '../src/auth/mailer';
import { PrismaClient } from '../src/generated/prisma/client';
import { LedgerSource } from '../src/generated/prisma/enums';
import { configureApp } from '../src/http/configure-app';
import { UserThrottlerGuard } from '../src/http/user-throttler.guard';
import { OutboxService } from '../src/outbox/outbox.service';
import { SessionChangeListener } from '../src/realtime/session-change.listener';
import { SessionGateway } from '../src/realtime/session.gateway';
import { BayController, SessionController } from '../src/session/session.controller';
import { SessionQueries } from '../src/session/session.queries';
import { SessionService } from '../src/session/session.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { WalletController } from '../src/wallet/wallet.controller';
import { WalletService } from '../src/wallet/wallet.service';
import { resetDatabase, testPrisma } from './db';

const STATION = 'STATION-01';
const BAY = 'BAY-001';
const DEVICE = '4CC382C3CC1C';
const PRICE = 50;

describe('Peron/seans HTTP + Socket.IO (gercek PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let auth: AuthService;
  let sessions: SessionService;
  let wallets: WalletService;
  let baseUrl: string;
  const sockets: Socket[] = [];

  beforeAll(() => {
    prisma = testPrisma();
    wallets = new WalletService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    auth = new AuthService(prisma, {
      accessSecret: 's'.repeat(40),
      customerAppUrl: 'http://app.test',
      mailer: new CapturingMailer(),
      google: null,
    });
    sessions = new SessionService(prisma, wallets, new OutboxService(prisma));
    const queries = new SessionQueries(prisma, sessions);
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
      controllers: [BayController, SessionController, WalletController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: AuthService, useValue: auth },
        { provide: SessionService, useValue: sessions },
        { provide: SessionQueries, useValue: queries },
        {
          provide: SessionChangeListener,
          useValue: new SessionChangeListener(process.env.TEST_DATABASE_URL!),
        },
        { provide: APP_GUARD, useClass: UserThrottlerGuard },
        AccessTokenGuard,
        SessionGateway,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://app.test']);
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    await seedBay();
  });

  afterEach(async () => {
    sockets.splice(0).forEach((s) => s.disconnect());
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  // ---------------------------------------------------------------- yardimcilar

  async function seedBay(): Promise<void> {
    const station = await prisma.station.create({ data: { code: STATION, name: 'Merkez' } });
    const water = await prisma.washProgram.create({
      data: { stationId: station.id, code: 'WATER', name: 'Su', pricePerSecondKurus: PRICE },
    });
    const foam = await prisma.washProgram.create({
      data: { stationId: station.id, code: 'FOAM', name: 'Kopuk', pricePerSecondKurus: 100 },
    });
    const bay = await prisma.bay.create({
      data: { bayCode: BAY, name: 'Peron 1', stationId: station.id },
    });
    await prisma.bayProgram.createMany({
      data: [
        { bayId: bay.id, programId: water.id, relayIndex: 1 },
        { bayId: bay.id, programId: foam.id, relayIndex: 2, isEnabled: false },
      ],
    });
    await device({ type: 'DEVICE_STATUS', status: 'ONLINE', firmwareVersion: 'test' });
  }

  function device(payload: { type: string } & Record<string, unknown>) {
    const kind =
      payload.type === 'DEVICE_STATUS'
        ? 'status'
        : ['STARTED_ACK', 'STOPPED_ACK'].includes(payload.type)
          ? 'ack'
          : 'events';
    return sessions.handleDeviceMessage(
      `qwash/station/${STATION}/bay/${BAY}/${kind}`,
      JSON.stringify({
        deviceId: DEVICE,
        stationId: STATION,
        bayId: BAY,
        eventId: randomUUID(),
        payload,
      }),
    );
  }

  let seq = 0;
  async function customer(balanceKurus: number): Promise<{ token: string; userId: string }> {
    const n = ++seq;
    const s = await auth.register({
      email: `m${n}@test.local`,
      password: 'gizli-sifre-1',
      fullName: `Musteri ${n}`,
    });
    if (balanceKurus > 0) {
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: s.user.id } });
      await wallets.credit({
        walletId: wallet.id,
        amountKurus: balanceKurus,
        source: LedgerSource.CARD_TOPUP,
        idempotencyKey: `t-${n}`,
      });
    }
    return { token: s.accessToken, userId: s.user.id };
  }

  function startSession(token: string, key: string = randomUUID(), durationSec = 60) {
    return http()
      .post('/api/v1/sessions')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ bayCode: BAY, programCode: 'WATER', durationSec });
  }

  /** Baglanir; gelen session.updated olaylarini biriktirir. */
  async function connect(token?: string): Promise<{ socket: Socket; updates: SessionView[] }> {
    const socket = io(baseUrl, {
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(socket);
    const updates: SessionView[] = [];
    socket.on(SOCKET_EVENTS.SESSION_UPDATED, (v: SessionView) => updates.push(v));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    // Sunucu odaya katilmayi handleConnection'da bitirir; kisa bir tur beklenir.
    await new Promise((r) => setTimeout(r, 100));
    return { socket, updates };
  }

  async function waitFor<T>(check: () => T | undefined, ms = 3_000): Promise<T> {
    const until = Date.now() + ms;
    for (;;) {
      const v = check();
      if (v !== undefined) return v;
      if (Date.now() > until) throw new Error('beklenen olay gelmedi');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  // ---------------------------------------------------------------- QR onay

  it('QR onayi: giris gerektirmez, yalniz etkin programlar ve peron uygunlugu doner', async () => {
    const res = await http().get(`/api/v1/bays/${BAY}`).expect(200);
    expect(res.body.data).toEqual({
      bayCode: BAY,
      bayName: 'Peron 1',
      stationName: 'Merkez',
      available: true,
      unavailableReason: null,
      programs: [
        { code: 'WATER', name: 'Su', description: null, icon: null, pricePerSecondKurus: PRICE },
      ],
      maxDurationSec: 3600,
    });

    const unknown = await http().get('/api/v1/bays/BAY-999').expect(404);
    expect(unknown.body).toMatchObject({ success: false, error: { code: 'BAY_NOT_FOUND' } });
    await http().get('/api/v1/bays/..%2Fadmin').expect(404);
  });

  it('QR onayi: cihaz cevrimdisi / bakim / dolu peron uygun gorunmez', async () => {
    await device({ type: 'DEVICE_STATUS', status: 'OFFLINE' });
    let res = await http().get(`/api/v1/bays/${BAY}`).expect(200);
    expect(res.body.data).toMatchObject({ available: false, unavailableReason: 'DEVICE_OFFLINE' });

    await device({ type: 'DEVICE_STATUS', status: 'ONLINE', firmwareVersion: 'test' });
    const { token } = await customer(10_000);
    await startSession(token).expect(201);
    res = await http().get(`/api/v1/bays/${BAY}`).expect(200);
    expect(res.body.data).toMatchObject({ available: false, unavailableReason: 'BUSY' });

    await prisma.bay.update({ where: { bayCode: BAY }, data: { status: 'MAINTENANCE' } });
    res = await http().get(`/api/v1/bays/${BAY}`).expect(200);
    expect(res.body.data).toMatchObject({ available: false, unavailableReason: 'MAINTENANCE' });
  });

  // ---------------------------------------------------------------- REST

  it('baslatma giris ve Idempotency-Key ister; tekrar ayni seansi doner', async () => {
    await http()
      .post('/api/v1/sessions')
      .send({ bayCode: BAY, programCode: 'WATER', durationSec: 60 })
      .expect(401);
    const { token } = await customer(10_000);
    const noKey = await http()
      .post('/api/v1/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({ bayCode: BAY, programCode: 'WATER', durationSec: 60 })
      .expect(400);
    expect(noKey.body).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });

    const first = await startSession(token, 'k-1').expect(201);
    const view = first.body.data as SessionView;
    expect(view).toMatchObject({
      status: 'STARTING',
      bayCode: BAY,
      programCode: 'WATER',
      plannedDurationSec: 60,
      heldKurus: 60 * PRICE,
      startedAt: null,
      stopRequested: false,
    });
    const again = await startSession(token, 'k-1').expect(201);
    expect((again.body.data as SessionView).sessionId).toBe(view.sessionId);

    const active = await http()
      .get('/api/v1/sessions/active')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((active.body.data as SessionView).sessionId).toBe(view.sessionId);
  });

  it('is kurali hatalari: yetersiz bakiye, kapali program, gecersiz sure, dolu peron', async () => {
    const poor = await customer(100);
    const funds = await startSession(poor.token).expect(422);
    expect(funds.body).toMatchObject({
      error: { code: 'INSUFFICIENT_FUNDS', details: { requiredKurus: 3000, currentKurus: 100 } },
    });

    const { token } = await customer(10_000);
    const foam = await http()
      .post('/api/v1/sessions')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'k-foam')
      .send({ bayCode: BAY, programCode: 'FOAM', durationSec: 60 })
      .expect(422);
    expect(foam.body).toMatchObject({ error: { code: 'PROGRAM_NOT_AVAILABLE' } });

    const long = await startSession(token, 'k-long', 3601).expect(400);
    expect(long.body).toMatchObject({ error: { code: 'INVALID_DURATION' } });

    await startSession(token, 'k-ok').expect(201);
    const other = await customer(10_000);
    const busy = await startSession(other.token).expect(422);
    expect(busy.body).toMatchObject({ error: { code: 'BAY_BUSY' } });
  });

  it('baslatma hiz siniri kullanici basina: ayni IP deki baska musteri etkilenmez', async () => {
    const eager = await customer(10_000);
    const calm = await customer(10_000);
    for (let i = 0; i < 3; i++) await startSession(eager.token, 'k-same');
    const limited = await startSession(eager.token, 'k-same').expect(429);
    expect(limited.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    // Ayni IP (127.0.0.1), farkli kullanici: kendi kotasi var (peron dolu oldugu icin 422)
    const other = await startSession(calm.token).expect(422);
    expect(other.body).toMatchObject({ error: { code: 'BAY_BUSY' } });
  });

  it('bakiye: giris ister; seans blokesi kullanilabilir bakiyeden duser', async () => {
    await http().get('/api/v1/wallet').expect(401);
    const { token } = await customer(10_000);
    const before = await http()
      .get('/api/v1/wallet')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(before.body.data).toEqual({
      balanceKurus: 10_000,
      holdKurus: 0,
      availableKurus: 10_000,
    });
    await startSession(token).expect(201);
    const after = await http()
      .get('/api/v1/wallet')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(after.body.data).toEqual({
      balanceKurus: 10_000,
      holdKurus: 60 * PRICE,
      availableKurus: 10_000 - 60 * PRICE,
    });
  });

  it('baska kullanicinin seansi gorulemez ve durdurulamaz', async () => {
    const owner = await customer(10_000);
    const started = await startSession(owner.token).expect(201);
    const id = (started.body.data as SessionView).sessionId;
    const stranger = await customer(10_000);

    await http()
      .get(`/api/v1/sessions/${id}`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(404);
    await http()
      .post(`/api/v1/sessions/${id}/stop`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(404);
    const active = await http()
      .get('/api/v1/sessions/active')
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(200);
    expect(active.body.data).toBeNull();
  });

  it('kapali hesap seans baslatamaz', async () => {
    const { token, userId } = await customer(10_000);
    await prisma.user.update({ where: { id: userId }, data: { status: 'DELETED' } });
    const res = await startSession(token).expect(403);
    expect(res.body).toMatchObject({ error: { code: 'ACCOUNT_NOT_ACTIVE' } });
  });

  // ---------------------------------------------------------------- Socket.IO

  it('tokensiz veya gecersiz tokenli soket reddedilir', async () => {
    for (const token of [undefined, 'bozuk-token']) {
      const socket = io(baseUrl, {
        auth: token ? { token } : {},
        transports: ['websocket'],
        reconnection: false,
      });
      sockets.push(socket);
      const code = await new Promise<string>((resolve) => {
        socket.once(SOCKET_EVENTS.AUTH_ERROR, (e: { code: string }) => resolve(e.code));
      });
      expect(code).toBe('UNAUTHENTICATED');
      await waitFor(() => (socket.connected ? undefined : true));
    }
  });

  it('uctan uca: baslat -> RUNNING -> durdur -> COMPLETED anlik gelir, baskasina gitmez', async () => {
    const owner = await customer(10_000);
    const stranger = await customer(10_000);
    const mine = await connect(owner.token);
    const theirs = await connect(stranger.token);

    const started = await startSession(owner.token).expect(201);
    const id = (started.body.data as SessionView).sessionId;
    await waitFor(() => mine.updates.find((u) => u.status === 'STARTING'));

    const row = await prisma.washSession.findUniqueOrThrow({ where: { id } });
    await device({
      type: 'STARTED_ACK',
      commandId: row.startCommandId,
      sessionId: id,
      status: 'SUCCESS',
    });
    const running = await waitFor(() => mine.updates.find((u) => u.status === 'RUNNING'));
    expect(running.startedAt).not.toBeNull();

    await http()
      .post(`/api/v1/sessions/${id}/stop`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    await waitFor(() => mine.updates.find((u) => u.stopRequested));

    await device({ type: 'SESSION_ENDED', sessionId: id, reason: 'STOPPED', remainingSec: 55 });
    const done = await waitFor(() => mine.updates.find((u) => u.status === 'COMPLETED'));
    expect(done).toMatchObject({ usedSeconds: 5, chargedKurus: 5 * PRICE });

    // Tek yukleme: bildirim sirasi korunur, son olay COMPLETED
    expect(mine.updates.at(-1)?.status).toBe('COMPLETED');
    expect(theirs.updates).toEqual([]);
  });

  it('dinleyici baglantisi koparsa yeniden kurulur, istemciye resync gider', async () => {
    const { token } = await customer(10_000);
    const mine = await connect(token);
    let resync = false;
    mine.socket.on(SOCKET_EVENTS.RESYNC, () => {
      resync = true;
    });

    await prisma.$queryRaw`
      SELECT pg_terminate_backend(pid)::text FROM pg_stat_activity
      WHERE query ILIKE 'LISTEN %' AND pid <> pg_backend_pid()`;
    await waitFor(() => (resync ? true : undefined), 6_000);

    await startSession(token).expect(201);
    await waitFor(() => mine.updates.find((u) => u.status === 'STARTING'));
  });

  it('basarisiz baslatma bildirim uretmez', async () => {
    const { token } = await customer(100); // yetersiz bakiye: transaction geri alinir
    const mine = await connect(token);
    await startSession(token).expect(422);
    await new Promise((r) => setTimeout(r, 300));
    expect(mine.updates).toEqual([]);
  });
});
