import { randomUUID } from 'node:crypto';
import type { AdminActor } from '../src/admin/admin.guard';
import { ProgramService } from '../src/admin/program.service';
import { PrismaClient } from '../src/generated/prisma/client';
import { LedgerSource, UserRole } from '../src/generated/prisma/enums';
import { OutboxService } from '../src/outbox/outbox.service';
import { SessionService } from '../src/session/session.service';
import { WalletService } from '../src/wallet/wallet.service';
import { resetDatabase, testPrisma } from './db';

describe('Admin program ve tarife yonetimi (gercek PostgreSQL)', () => {
  let prisma: PrismaClient;
  let programs: ProgramService;
  let stationId: string;
  let bayId: string;
  let actor: AdminActor;

  beforeAll(() => {
    prisma = testPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    programs = new ProgramService(prisma);
    const station = await prisma.station.create({ data: { code: 'STATION-01', name: 'Test' } });
    stationId = station.id;
    bayId = (await prisma.bay.create({ data: { bayCode: 'BAY-001', name: 'P1', stationId } })).id;
    const u = await prisma.user.create({
      data: { email: 'su@test.local', role: UserRole.SUPER_ADMIN },
    });
    actor = { userId: u.id, role: 'SUPER_ADMIN' };
  });

  const create = (code: string, price = 50) =>
    programs.create(actor, {
      stationId,
      code,
      name: `Program ${code}`,
      pricePerSecondKurus: price,
    });

  it('olusturma, guncelleme ve soft-delete denetime yazilir; silinen listeden kalkar', async () => {
    const p = await create('WATER');
    expect(p).toMatchObject({ code: 'WATER', pricePerSecondKurus: 50, isActive: true });

    const updated = await programs.update(actor, p.id, {
      name: 'Basincli Su',
      description: null,
      icon: 'water',
      pricePerSecondKurus: 60,
      isActive: true,
    });
    expect(updated.pricePerSecondKurus).toBe(60);

    await programs.remove(actor, p.id);
    expect(await programs.list(stationId, false)).toEqual([]);
    expect((await programs.list(stationId, true))[0]).toMatchObject({
      deleted: true,
      isActive: false,
    });
    await expect(programs.remove(actor, p.id)).rejects.toMatchObject({ code: 'PROGRAM_NOT_FOUND' });

    const actions = (await prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'asc' } })).map(
      (a) => a.action,
    );
    expect(actions).toEqual(['PROGRAM_CREATED', 'PROGRAM_UPDATED', 'PROGRAM_DELETED']);
    const upd = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: 'PROGRAM_UPDATED' },
    });
    expect(upd.details).toMatchObject({
      before: { pricePerSecondKurus: 50 },
      after: { pricePerSecondKurus: 60 },
    });
  });

  it('ayni kod (silinmis olsa da) ikinci kez kullanilamaz', async () => {
    const p = await create('WAX');
    await expect(create('WAX')).rejects.toMatchObject({ code: 'PROGRAM_CODE_TAKEN' });
    await programs.remove(actor, p.id);
    await expect(create('WAX')).rejects.toMatchObject({ code: 'PROGRAM_CODE_TAKEN' });
  });

  it('peron eslemesi: role cakismasi reddedilir, iki programin rolesi tek istekte takas edilir', async () => {
    const a = await create('A');
    const b = await create('B');
    await expect(
      programs.setBayPrograms(actor, bayId, {
        programs: [
          { programId: a.id, relayIndex: 1, isEnabled: true },
          { programId: b.id, relayIndex: 1, isEnabled: true },
        ],
      }),
    ).rejects.toMatchObject({ code: 'RELAY_CONFLICT' });

    await programs.setBayPrograms(actor, bayId, {
      programs: [
        { programId: a.id, relayIndex: 1, isEnabled: true },
        { programId: b.id, relayIndex: 2, isEnabled: true },
      ],
    });
    // Takas: A 2'ye, B 1'e (unique kisiti ara durumda ihlal edilmemeli).
    const after = await programs.setBayPrograms(actor, bayId, {
      programs: [
        { programId: a.id, relayIndex: 2, isEnabled: true },
        { programId: b.id, relayIndex: 1, isEnabled: false },
      ],
    });
    const byCode = Object.fromEntries(after.map((p) => [p.code, p.bays[0]]));
    expect(byCode.A).toMatchObject({ relayIndex: 2, isEnabled: true });
    expect(byCode.B).toMatchObject({ relayIndex: 1, isEnabled: false });
  });

  it('silinmis veya baska istasyonun programi perona atanamaz', async () => {
    const a = await create('A');
    await programs.remove(actor, a.id);
    await expect(
      programs.setBayPrograms(actor, bayId, {
        programs: [{ programId: a.id, relayIndex: 1, isEnabled: true }],
      }),
    ).rejects.toMatchObject({ code: 'PROGRAM_NOT_AVAILABLE' });

    const other = await prisma.station.create({ data: { code: 'STATION-02', name: 'B' } });
    const foreign = await programs.create(actor, {
      stationId: other.id,
      code: 'X',
      name: 'Yabanci',
      pricePerSecondKurus: 10,
    });
    await expect(
      programs.setBayPrograms(actor, bayId, {
        programs: [{ programId: foreign.id, relayIndex: 1, isEnabled: true }],
      }),
    ).rejects.toMatchObject({ code: 'PROGRAM_NOT_AVAILABLE' });
  });

  it('fiyat degisikligi suren seansi etkilemez, yeni seans yeni fiyati kullanir; pasif program baslatilamaz', async () => {
    const p = await create('WATER', 50);
    await programs.setBayPrograms(actor, bayId, {
      programs: [{ programId: p.id, relayIndex: 1, isEnabled: true }],
    });
    const wallets = new WalletService(prisma);
    const sessions = new SessionService(prisma, wallets, new OutboxService(prisma));
    await sessions.handleDeviceMessage(
      'qwash/station/STATION-01/bay/BAY-001/status',
      JSON.stringify({
        deviceId: 'DEV1',
        stationId: 'STATION-01',
        bayId: 'BAY-001',
        eventId: randomUUID(),
        payload: { type: 'DEVICE_STATUS', status: 'ONLINE', firmwareVersion: 't' },
      }),
    );
    const user = await prisma.user.create({ data: { email: 'c@test.local' } });
    const { walletId } = await wallets.createWallet(user.id);
    await wallets.credit({
      walletId,
      amountKurus: 100000,
      source: LedgerSource.CARD_TOPUP,
      idempotencyKey: 'c',
    });
    const start = () =>
      sessions.start({
        userId: user.id,
        bayCode: 'BAY-001',
        programCode: 'WATER',
        durationSec: 10,
        idempotencyKey: randomUUID(),
      });

    const first = await start();
    expect(first.pricePerSecondKurus).toBe(50);
    await programs.update(actor, p.id, {
      name: p.name,
      description: null,
      icon: null,
      pricePerSecondKurus: 80,
      isActive: true,
    });
    expect(
      (await prisma.washSession.findUniqueOrThrow({ where: { id: first.id } })).pricePerSecondKurus,
    ).toBe(50);

    await prisma.washSession.update({ where: { id: first.id }, data: { status: 'FAILED' } });
    await prisma.bay.update({ where: { id: bayId }, data: { status: 'IDLE' } });
    expect((await start()).pricePerSecondKurus).toBe(80);

    await programs.update(actor, p.id, {
      name: p.name,
      description: null,
      icon: null,
      pricePerSecondKurus: 80,
      isActive: false,
    });
    await prisma.washSession.updateMany({ data: { status: 'FAILED' } });
    await expect(start()).rejects.toMatchObject({ code: 'PROGRAM_NOT_AVAILABLE' });
  });

  it('denetim gecmisi hedefe gore filtrelenir ve yapan kisinin e-postasini gosterir', async () => {
    const p = await create('A');
    await programs.remove(actor, p.id);
    const log = await programs.auditLog(50, 'PROGRAM', p.id);
    expect(log.map((l) => l.action)).toEqual(['PROGRAM_DELETED', 'PROGRAM_CREATED']);
    expect(log[0]!.actorEmail).toBe('su@test.local');
  });
});
