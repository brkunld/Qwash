import { randomUUID } from 'node:crypto';
import type { AdminActor } from '../src/admin/admin.guard';
import { OpsService } from '../src/admin/ops.service';
import { PrismaClient } from '../src/generated/prisma/client';
import type { WashSession } from '../src/generated/prisma/client';
import { LedgerSource, SessionStatus, UserRole } from '../src/generated/prisma/enums';
import { OutboxService } from '../src/outbox/outbox.service';
import { BayUnavailableError } from '../src/session/session.errors';
import { SessionService } from '../src/session/session.service';
import { WalletService } from '../src/wallet/wallet.service';
import { resetDatabase, testPrisma } from './db';

const STATION = 'STATION-01';
const BAY = 'BAY-001';
const DEVICE = '4CC382C3CC1C';
const PRICE = 50;

describe('Admin peron ve seans operasyonlari (gercek PostgreSQL)', () => {
  let prisma: PrismaClient;
  let wallets: WalletService;
  let sessions: SessionService;
  let ops: OpsService;
  let nowMs: number;
  let seq = 0;
  let bayId: string;
  let admin: AdminActor;

  const clock = () => new Date(nowMs);

  beforeAll(() => {
    prisma = testPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    nowMs = Date.now();
    wallets = new WalletService(prisma);
    sessions = new SessionService(prisma, wallets, new OutboxService(prisma, clock), clock);
    ops = new OpsService(prisma, sessions, wallets);

    const station = await prisma.station.create({ data: { code: STATION, name: 'Test' } });
    const program = await prisma.washProgram.create({
      data: { stationId: station.id, code: 'WATER', name: 'Su', pricePerSecondKurus: PRICE },
    });
    const bay = await prisma.bay.create({
      data: { bayCode: BAY, name: BAY, stationId: station.id },
    });
    bayId = bay.id;
    await prisma.bayProgram.create({ data: { bayId, programId: program.id, relayIndex: 1 } });
    await device({ type: 'DEVICE_STATUS', status: 'ONLINE', firmwareVersion: 'test' });

    const a = await prisma.user.create({ data: { email: 'op@test.local', role: UserRole.ADMIN } });
    admin = { userId: a.id, role: 'ADMIN' };
  });

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

  async function running(durationSec = 60): Promise<WashSession> {
    const user = await prisma.user.create({ data: { email: `c${++seq}@test.local` } });
    const { walletId } = await wallets.createWallet(user.id);
    await wallets.credit({
      walletId,
      amountKurus: 10000,
      source: LedgerSource.CARD_TOPUP,
      idempotencyKey: `t-${seq}`,
    });
    const s = await sessions.start({
      userId: user.id,
      bayCode: BAY,
      programCode: 'WATER',
      durationSec,
      idempotencyKey: randomUUID(),
    });
    await device({
      type: 'STARTED_ACK',
      commandId: s.startCommandId,
      sessionId: s.id,
      status: 'SUCCESS',
    });
    return prisma.washSession.findUniqueOrThrow({ where: { id: s.id } });
  }

  it('bakim modu yeni seansi engeller, suren seansi kesmez; seans bitince peron bakimda kalir', async () => {
    const s = await running(60);
    const bay = await ops.setMaintenance(admin, bayId, { enabled: true, reason: 'Nozul degisimi' });
    expect(bay.maintenance).toMatchObject({ reason: 'Nozul degisimi', by: admin.userId });
    expect(bay.problem).toBe('MAINTENANCE');
    expect(bay.activeSession?.id).toBe(s.id);

    // Suren seansa STOP gonderilmedi.
    expect(await prisma.outboxEvent.count({ where: { sessionId: s.id } })).toBe(1); // yalniz START

    nowMs += 60_000;
    await device({ type: 'SESSION_ENDED', sessionId: s.id, reason: 'COMPLETED', remainingSec: 0 });
    const after = (await ops.bays())[0]!;
    expect(after.status).toBe('IDLE'); // calisma durumu
    expect(after.problem).toBe('MAINTENANCE'); // ama baslatilamaz
    await expect(running()).rejects.toBeInstanceOf(BayUnavailableError);

    await ops.setMaintenance(admin, bayId, { enabled: false });
    expect((await ops.bays())[0]!.problem).toBeNull();
    const audits = await prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.action)).toEqual(['BAY_MAINTENANCE_ON', 'BAY_MAINTENANCE_OFF']);
  });

  it('acil durdurma: STOP (ADMIN_OVERRIDE) gider, tahsilat kullanilan sure kadar', async () => {
    const s = await running(60);
    nowMs += 10_000;
    const view = await ops.stopSession(admin, s.id, 'Musteri arac icinde kaldi, acil');
    expect(view.transitions.map((t) => t.reason)).toContain('ADMIN_STOP_REQUESTED');

    const stop = await prisma.outboxEvent.findFirstOrThrow({
      where: { sessionId: s.id, payload: { path: ['payload', 'type'], equals: 'STOP' } },
    });
    expect(stop.payload).toMatchObject({ payload: { reason: 'ADMIN_OVERRIDE' } });

    await device({ type: 'SESSION_ENDED', sessionId: s.id, reason: 'STOPPED', remainingSec: 50 });
    const done = await prisma.washSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(done).toMatchObject({ status: SessionStatus.COMPLETED, usedSeconds: 10 });
    expect(Number(done.chargedKurus)).toBe(10 * PRICE);
    expect(
      await prisma.adminAuditLog.count({ where: { action: 'SESSION_ADMIN_STOP', targetId: s.id } }),
    ).toBe(1);

    await expect(ops.stopSession(admin, s.id, 'Tekrar durduruyorum bunu')).rejects.toMatchObject({
      code: 'SESSION_NOT_ACTIVE',
    });
  });

  it('inceleme kuyrugu: needsReview seansi bir kez kapatilir, para hareket etmez', async () => {
    const s = await running(30);
    await prisma.washSession.update({ where: { id: s.id }, data: { needsReview: true } });
    const ledgerBefore = await prisma.ledgerEntry.count();

    expect((await ops.reviewQueue(true)).map((r) => r.id)).toEqual([s.id]);
    const reviewed = await ops.markReviewed(admin, s.id, 'Cihaz loglari kontrol edildi, sorun yok');
    expect(reviewed.reviewNote).toBe('Cihaz loglari kontrol edildi, sorun yok');
    expect(await ops.reviewQueue(true)).toEqual([]);
    expect((await ops.reviewQueue(false)).map((r) => r.id)).toEqual([s.id]);
    expect(await prisma.ledgerEntry.count()).toBe(ledgerBefore);

    await expect(ops.markReviewed(admin, s.id, 'Ikinci kez inceliyorum')).rejects.toMatchObject({
      code: 'ALREADY_REVIEWED',
    });
  });

  describe('teknik hata iadesi (bakiyeye)', () => {
    async function completed(usedSec: number): Promise<WashSession> {
      const s = await running(60);
      nowMs += usedSec * 1000;
      await device({
        type: 'SESSION_ENDED',
        sessionId: s.id,
        reason: 'COMPLETED',
        remainingSec: 60 - usedSec,
      });
      return prisma.washSession.findUniqueOrThrow({ where: { id: s.id } });
    }

    const balance = async (walletId: string) =>
      Number((await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } })).balanceKurus);

    it('tahsil edilen tutar cuzdana geri yazilir, denetim kaydi olusur', async () => {
      const s = await completed(20);
      const charged = Number(s.chargedKurus);
      expect(charged).toBe(20 * PRICE);
      const before = await balance(s.walletId);

      const view = await ops.serviceRefund(admin, s.id, {
        reason: 'Peron su vermedi, pompa arizasi',
      });
      expect(view.serviceRefund).toMatchObject({ amountKurus: charged });
      expect(await balance(s.walletId)).toBe(before + charged);

      const entry = await prisma.ledgerEntry.findUniqueOrThrow({
        where: { idempotencyKey: `service-refund:${s.id}` },
      });
      expect(entry).toMatchObject({ type: 'CREDIT', source: 'SERVICE_REFUND', referenceId: s.id });
      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: 'SESSION_SERVICE_REFUND', targetId: s.id },
      });
      expect(audit.actorId).toBe(admin.userId);
    });

    it('kismi iade olur; tahsil edileni asan tutar reddedilir', async () => {
      const s = await completed(20);
      await expect(
        ops.serviceRefund(admin, s.id, {
          reason: 'Fazla tutar deniyorum',
          amountKurus: 20 * PRICE + 1,
        }),
      ).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_CHARGE' });
      const view = await ops.serviceRefund(admin, s.id, {
        reason: 'Son 5 saniye kopuk basinc',
        amountKurus: 5 * PRICE,
      });
      expect(view.serviceRefund?.amountKurus).toBe(5 * PRICE);
    });

    it('seans basina bir kez; eszamanli iki istekte yalniz biri gecer', async () => {
      const s = await completed(20);
      const before = await balance(s.walletId);
      const results = await Promise.allSettled([
        ops.serviceRefund(admin, s.id, { reason: 'Ilk operator iade ediyor' }),
        ops.serviceRefund(admin, s.id, { reason: 'Ikinci operator iade ediyor' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: 'SESSION_ALREADY_REFUNDED' });
      expect(await balance(s.walletId)).toBe(before + 20 * PRICE);

      await expect(
        ops.serviceRefund(admin, s.id, { reason: 'Ucuncu kez deniyorum' }),
      ).rejects.toMatchObject({ code: 'SESSION_ALREADY_REFUNDED' });
    });

    it('suren veya ucretsiz seans iade edilemez', async () => {
      const s = await running(60);
      await expect(
        ops.serviceRefund(admin, s.id, { reason: 'Suren seansi iade ediyorum' }),
      ).rejects.toMatchObject({ code: 'SESSION_NOT_REFUNDABLE' });
      expect(await prisma.ledgerEntry.count({ where: { source: 'SERVICE_REFUND' } })).toBe(0);
    });

    it('silinmis hesaba iade yazilmaz', async () => {
      const s = await completed(20);
      await prisma.user.update({ where: { id: s.userId }, data: { status: 'DELETED' } });
      await expect(
        ops.serviceRefund(admin, s.id, { reason: 'Silinmis hesaba iade deniyorum' }),
      ).rejects.toMatchObject({ code: 'TARGET_ACCOUNT_NOT_ACTIVE' });
    });
  });

  it('dashboard cihaz sagligini ve baslatilabilirligi gosterir', async () => {
    const [bay] = await ops.bays();
    expect(bay).toMatchObject({
      bayCode: BAY,
      stationCode: STATION,
      problem: null,
      maintenance: null,
      activeSession: null,
      device: { deviceId: DEVICE, reportedStatus: 'ONLINE', firmwareVersion: 'test' },
    });
    nowMs += 10 * 60_000; // cihaz sessiz
    expect((await ops.bays())[0]!.problem).toBe('DEVICE_STALE');
  });
});
