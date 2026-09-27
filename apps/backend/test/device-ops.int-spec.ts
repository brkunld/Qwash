import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { PrismaClient } from '../src/generated/prisma/client';
import { FirmwareUpdateStatus, LedgerSource } from '../src/generated/prisma/enums';
import { configureApp } from '../src/http/configure-app';
import type { CommandEnvelope, OtaCommandPayload } from '../src/iot/iot.contract';
import { OutboxService, type MessagePublisher } from '../src/outbox/outbox.service';
import { BayClaimService } from '../src/session/bay-claim.service';
import {
  DEFAULT_DEVICE_OPS_TIMINGS,
  DeviceOpsService,
  FirmwareUpdateError,
} from '../src/session/device-ops.service';
import { FIRMWARE_DIR, FirmwareController } from '../src/session/firmware.controller';
import { SessionService } from '../src/session/session.service';
import { WalletService } from '../src/wallet/wallet.service';
import { resetDatabase, testPrisma } from './db';

const STATION = 'STATION-01';
const BAY = 'BAY-001';
const DEVICE = '4CC382C3CC1C';
const QR = 'https://qwash.test/b/';
const API = 'http://192.168.1.7:3001';
const T = (kind: string) => `qwash/station/${STATION}/bay/${BAY}/${kind}`;

class FakePublisher implements MessagePublisher {
  sent: { topic: string; envelope: CommandEnvelope }[] = [];
  async publish(topic: string, payload: string): Promise<void> {
    this.sent.push({ topic, envelope: JSON.parse(payload) as CommandEnvelope });
  }
  ofType(type: string) {
    return this.sent.filter((m) => m.envelope.payload.type === type);
  }
}

describe('Cihaz ayari ve firmware guncellemesi (DeviceOpsService, gercek PostgreSQL)', () => {
  let prisma: PrismaClient;
  let outbox: OutboxService;
  let sessions: SessionService;
  let wallets: WalletService;
  let ops: DeviceOpsService;
  let claims: BayClaimService;
  let publisher: FakePublisher;
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
    outbox = new OutboxService(prisma, clock);
    wallets = new WalletService(prisma);
    sessions = new SessionService(prisma, wallets, outbox, clock);
    claims = new BayClaimService(prisma, sessions, outbox, clock);
    ops = new DeviceOpsService(prisma, sessions, outbox, { qrBase: QR, deviceApiUrl: API }, clock);
    publisher = new FakePublisher();
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
    await status({ status: 'ONLINE', firmwareVersion: '0.6.0-touch' });
  });

  function device(kind: string, payload: object, deviceId = DEVICE) {
    const env = { eventId: randomUUID(), deviceId, payload };
    return sessions.handleDeviceMessage(T(kind), JSON.stringify(env));
  }
  const status = (p: object) => device('status', { type: 'DEVICE_STATUS', ...p });

  async function release(version = '0.7.0') {
    return prisma.firmwareRelease.create({
      data: {
        version,
        sha256: 'ab'.repeat(32),
        sizeBytes: 1234,
        signature: 'c2ln',
        fileName: `qwash_bay-${version}.bin`,
      },
    });
  }

  async function flush() {
    await outbox.publishPending(publisher);
  }

  function tokenOf(cmd: { envelope: CommandEnvelope }): string {
    return (cmd.envelope.payload as OtaCommandPayload).url.split('/').pop()!;
  }

  // ---------------------------------------------------------------- QR adresi

  it('cihaz farkli QR adresi bildirirse SET_CONFIG gider; ayniysa veya eski firmware ise gitmez', async () => {
    await status({ status: 'ONLINE', qrBase: 'https://qwash.example/b/' });
    await flush();
    const [cmd] = publisher.ofType('SET_CONFIG');
    expect(cmd!.topic).toBe(T('cmd'));
    expect(cmd!.envelope).toMatchObject({
      deviceId: DEVICE,
      payload: { type: 'SET_CONFIG', qrBase: QR },
    });
    expect((await prisma.device.findUniqueOrThrow({ where: { deviceId: DEVICE } })).qrBase).toBe(
      'https://qwash.example/b/',
    );

    await status({ status: 'ONLINE', qrBase: QR }); // Cihaz uyguladi
    await status({ status: 'ONLINE' }); // Eski firmware: alan yok
    await status({ status: 'OFFLINE', qrBase: 'x' }); // Cevrimdisi (LWT)
    await flush();
    expect(publisher.ofType('SET_CONFIG')).toHaveLength(1);
  });

  it('peronu baska cihaz olan topic uzerinden ayar gonderilmez', async () => {
    await device(
      'status',
      { type: 'DEVICE_STATUS', status: 'ONLINE', qrBase: 'x' },
      'OTHERDEVICE0',
    );
    await flush();
    expect(publisher.ofType('SET_CONFIG')).toHaveLength(0);
  });

  // ---------------------------------------------------------------- guncelleme

  it('guncelleme: OTA komutu, tek seferlik indirme, cihaz bildirimleriyle SUCCEEDED', async () => {
    await release();
    const update = await ops.startUpdate(BAY, '0.7.0');
    expect(update).toMatchObject({
      deviceId: DEVICE,
      fromVersion: '0.6.0-touch',
      status: 'PENDING',
    });
    await flush();
    const [cmd] = publisher.ofType('OTA');
    expect(cmd!.envelope.payload).toMatchObject({
      type: 'OTA',
      updateId: update.id,
      version: '0.7.0',
      sha256: 'ab'.repeat(32),
      sizeBytes: 1234,
      signature: 'c2ln',
    });
    const url = (cmd!.envelope.payload as OtaCommandPayload).url;
    expect(url.startsWith(`${API}/api/v1/firmware/download/`)).toBe(true);

    // Anahtar veritabaninda duz saklanmaz; yanlis anahtar imaji vermez.
    expect(await prisma.firmwareUpdate.count({ where: { tokenHash: tokenOf(cmd!) } })).toBe(0);
    expect(await ops.resolveDownload('x'.repeat(43))).toBeNull();
    expect(await ops.resolveDownload(tokenOf(cmd!))).toEqual({
      fileName: 'qwash_bay-0.7.0.bin',
      sizeBytes: 1234,
    });

    await device('events', { type: 'OTA_STATUS', updateId: update.id, status: 'REBOOTING' });
    // Yeniden baslayan cihaz artik indiremez.
    expect(await ops.resolveDownload(tokenOf(cmd!))).toBeNull();
    await device('events', { type: 'OTA_STATUS', updateId: update.id, status: 'SUCCEEDED' });
    const done = await prisma.firmwareUpdate.findUniqueOrThrow({ where: { id: update.id } });
    expect(done.status).toBe(FirmwareUpdateStatus.SUCCEEDED);
    expect(done.finishedAt).not.toBeNull();
    // Bitmis guncellemeye gec gelen bildirim sonucu degistirmez.
    await device('events', {
      type: 'OTA_STATUS',
      updateId: update.id,
      status: 'FAILED',
      detail: 'x',
    });
    expect(
      (await prisma.firmwareUpdate.findUniqueOrThrow({ where: { id: update.id } })).status,
    ).toBe('SUCCEEDED');
  });

  it('indirme anahtarinin suresi dolunca imaj verilmez', async () => {
    await release();
    await ops.startUpdate(BAY, '0.7.0');
    await flush();
    advance(DEFAULT_DEVICE_OPS_TIMINGS.downloadTokenMs + 1);
    expect(await ops.resolveDownload(tokenOf(publisher.ofType('OTA')[0]!))).toBeNull();
  });

  it('cihaz basarisizligi bildirirse FAILED ve detay; baska cihazin bildirimi yok sayilir', async () => {
    await release();
    const update = await ops.startUpdate(BAY, '0.7.0');
    await device(
      'events',
      { type: 'OTA_STATUS', updateId: update.id, status: 'FAILED' },
      'OTHERDEVICE0',
    );
    expect(
      (await prisma.firmwareUpdate.findUniqueOrThrow({ where: { id: update.id } })).status,
    ).toBe('PENDING');
    await device('events', {
      type: 'OTA_STATUS',
      updateId: update.id,
      status: 'FAILED',
      detail: 'SIGNATURE',
    });
    expect(
      await prisma.firmwareUpdate.findUniqueOrThrow({ where: { id: update.id } }),
    ).toMatchObject({
      status: 'FAILED',
      detail: 'SIGNATURE',
    });
  });

  it('reddedilir: bilinmeyen surum, ayni surum, suren guncelleme, seans, ekran bagi', async () => {
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'OK',
        (e: unknown) =>
          e instanceof FirmwareUpdateError || e instanceof Error
            ? (e as { code?: string }).code
            : 'X',
      );
    expect(await code(ops.startUpdate(BAY, '9.9.9'))).toBe('FIRMWARE_NOT_FOUND');
    await release('0.6.0-touch');
    expect(await code(ops.startUpdate(BAY, '0.6.0-touch'))).toBe('FIRMWARE_SAME_VERSION');
    await release('0.7.0');
    await ops.startUpdate(BAY, '0.7.0');
    expect(await code(ops.startUpdate(BAY, '0.7.0'))).toBe('UPDATE_IN_PROGRESS');

    await resetDatabase(prisma);
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
    await status({ status: 'ONLINE', firmwareVersion: '0.6.0-touch' });
    await release('0.7.0');
    const user = await prisma.user.create({ data: { email: 'u@test.local' } });
    const { walletId } = await wallets.createWallet(user.id);
    await wallets.credit({
      walletId,
      amountKurus: 100_000,
      source: LedgerSource.CARD_TOPUP,
      idempotencyKey: 't',
    });

    await claims.claim(user.id, BAY);
    expect(await code(ops.startUpdate(BAY, '0.7.0'))).toBe('BAY_IN_USE');
    await claims.release(user.id, BAY);
    await sessions.start({
      userId: user.id,
      bayCode: BAY,
      programCode: 'WATER',
      durationSec: 60,
      idempotencyKey: 'k',
    });
    expect(await code(ops.startUpdate(BAY, '0.7.0'))).toBe('BAY_IN_USE');
  });

  it('zaman asimi: surum raporlandiysa SUCCEEDED, degilse FAILED', async () => {
    await release('0.7.0');
    const a = await ops.startUpdate(BAY, '0.7.0');
    advance(DEFAULT_DEVICE_OPS_TIMINGS.updateTimeoutMs);
    await status({ status: 'ONLINE', firmwareVersion: '0.7.0' });
    expect(await ops.sweep()).toBe(1);
    expect(await prisma.firmwareUpdate.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      status: 'SUCCEEDED',
      detail: 'VERSION_REPORTED',
    });

    await release('0.8.0');
    const b = await ops.startUpdate(BAY, '0.8.0');
    advance(DEFAULT_DEVICE_OPS_TIMINGS.updateTimeoutMs);
    await status({ status: 'ONLINE', firmwareVersion: '0.7.0' });
    await ops.sweep();
    expect(await prisma.firmwareUpdate.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({
      status: 'FAILED',
      detail: 'TIMEOUT (PENDING)',
    });
  });

  it('HTTP indirme: gecerli anahtarla ham imaj (zarfsiz), gecersizle 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qwash-fw-'));
    const image = Buffer.from('QWASH-FIRMWARE-IMAGE\0' + 'x'.repeat(1213));
    writeFileSync(join(dir, 'qwash_bay-0.7.0.bin'), image);
    await release('0.7.0');
    await ops.startUpdate(BAY, '0.7.0');
    await flush();
    const token = tokenOf(publisher.ofType('OTA')[0]!);

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [FirmwareController],
      providers: [
        { provide: DeviceOpsService, useValue: ops },
        { provide: FIRMWARE_DIR, useValue: dir },
      ],
    }).compile();
    const app: INestApplication = moduleRef.createNestApplication();
    configureApp(app, []);
    await app.init();
    try {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/firmware/download/${token}`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(Buffer.compare(res.body as Buffer, image)).toBe(0);
      await request(app.getHttpServer())
        .get(`/api/v1/firmware/download/${'y'.repeat(43)}`)
        .expect(404);
    } finally {
      await app.close();
    }
  });
});
