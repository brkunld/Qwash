import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../src/generated/prisma/client';
import {
  BayStatus,
  CardTopUpStatus,
  OutboxStatus,
  RefundPayoutStatus,
  SessionStatus,
} from '../src/generated/prisma/enums';
import {
  AlarmService,
  AlertNotifier,
  DEFAULT_ALARM_THRESHOLDS,
  type MqttStatus,
} from '../src/monitoring/alarm.service';
import { EmailAlertNotifier } from '../src/monitoring/email-alert-notifier';
import { resetDatabase, testPrisma } from './db';

const MIN = 60_000;

class FakeNotifier extends AlertNotifier {
  sent: { kind: string; severity: string; title: string }[] = [];
  failing = false;
  notify(alert: { kind: string; severity: string; title: string }): Promise<void> {
    if (this.failing) return Promise.reject(new Error('smtp yok'));
    this.sent.push({ kind: alert.kind, severity: alert.severity, title: alert.title });
    return Promise.resolve();
  }
}

describe('Alarmlar (AlarmService, gercek PostgreSQL)', () => {
  let prisma: PrismaClient;
  let alarms: AlarmService;
  let notifier: FakeNotifier;
  let mqtt: { isConnected: boolean } & MqttStatus;
  let nowMs: number;
  let bayId: string;
  let userId: string;
  let walletId: string;
  const clock = () => new Date(nowMs);
  const advance = (ms: number) => {
    nowMs += ms;
  };
  const ago = (ms: number) => new Date(nowMs - ms);

  beforeAll(() => {
    prisma = testPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    nowMs = Date.parse('2026-09-27T12:00:00.000Z');
    notifier = new FakeNotifier();
    mqtt = { isConnected: true };
    alarms = new AlarmService(prisma, mqtt, notifier, clock);
    const station = await prisma.station.create({ data: { code: 'STATION-01', name: 'Test' } });
    const program = await prisma.washProgram.create({
      data: { stationId: station.id, code: 'WATER', name: 'Su', pricePerSecondKurus: 50 },
    });
    const bay = await prisma.bay.create({
      data: { bayCode: 'BAY-001', name: 'Peron 1', stationId: station.id },
    });
    bayId = bay.id;
    await prisma.bayProgram.create({ data: { bayId, programId: program.id, relayIndex: 1 } });
    await prisma.device.create({
      data: {
        deviceId: '4CC382C3CC1C',
        bayId,
        reportedStatus: 'ONLINE',
        firmwareVersion: '0.7.1',
        lastSeenAt: clock(),
      },
    });
    const user = await prisma.user.create({ data: { email: 'a@test.local' } });
    userId = user.id;
    walletId = (await prisma.wallet.create({ data: { userId } })).id;
  });

  async function session(over: Record<string, unknown> = {}) {
    const hold = await prisma.walletHold.create({
      data: { walletId, amountKurus: 100, source: 'SESSION', idempotencyKey: randomUUID() },
    });
    const program = await prisma.washProgram.findFirstOrThrow();
    return prisma.washSession.create({
      data: {
        userId,
        walletId,
        bayId,
        programId: program.id,
        relayIndex: 1,
        pricePerSecondKurus: 50,
        plannedDurationSec: 60,
        holdId: hold.id,
        idempotencyKey: randomUUID(),
        startCommandId: randomUUID(),
        ackDeadlineAt: clock(),
        ...over,
      },
    });
  }

  it('saglikli sistemde alarm yok', async () => {
    expect(await alarms.sweep()).toBe(0);
    expect(await alarms.active()).toEqual([]);
    expect(notifier.sent).toEqual([]);
  });

  it('cihaz cevrimdisi: 3 dk sonra bir kez bildirilir, geri gelince kapanir', async () => {
    advance(2 * MIN);
    expect(await alarms.sweep()).toBe(0);
    advance(2 * MIN); // toplam 4 dk sessiz
    expect(await alarms.sweep()).toBe(1);
    expect(notifier.sent).toEqual([
      { kind: 'FIRING', severity: 'CRITICAL', title: 'Peron cihazi cevrimdisi: BAY-001' },
    ]);
    const [a] = await alarms.active();
    expect(a).toMatchObject({ key: 'device-offline:BAY-001', severity: 'CRITICAL' });

    // Ayni kosul suruyor: yeni e-posta yok.
    advance(5 * MIN);
    await alarms.sweep();
    await alarms.sweep();
    expect(notifier.sent).toHaveLength(1);

    // Cihaz dondu.
    await prisma.device.update({
      where: { deviceId: '4CC382C3CC1C' },
      data: { lastSeenAt: clock() },
    });
    expect(await alarms.sweep()).toBe(0);
    expect(await alarms.active()).toEqual([]);
    expect(notifier.sent.map((n) => n.kind)).toEqual(['FIRING', 'RESOLVED']);
  });

  it('acik alarm 6 saatte bir hatirlatilir; backend yeniden baslasa ayni alarm yeni sayilmaz', async () => {
    advance(10 * MIN);
    await alarms.sweep();
    // Yeni surec (bellekteki durum sifir), veritabani ayni.
    const restarted = new AlarmService(prisma, mqtt, notifier, clock);
    await restarted.sweep();
    expect(notifier.sent).toHaveLength(1);
    advance(DEFAULT_ALARM_THRESHOLDS.repeatMs);
    await restarted.sweep();
    expect(notifier.sent.map((n) => n.kind)).toEqual(['FIRING', 'REMINDER']);
  });

  it('bakimdaki peron cevrimdisi sayilmaz', async () => {
    await prisma.bay.update({
      where: { id: bayId },
      data: {
        outOfServiceKind: 'MAINTENANCE',
        outOfServiceAt: clock(),
        status: BayStatus.MAINTENANCE,
      },
    });
    advance(30 * MIN);
    expect(await alarms.sweep()).toBe(0);
  });

  it('kapali peron cevrimdisi sayilmaz (gece cihaz kapatilabilir)', async () => {
    await prisma.bay.update({
      where: { id: bayId },
      data: { outOfServiceKind: 'CLOSED', outOfServiceAt: clock() },
    });
    advance(30 * MIN);
    expect(await alarms.sweep()).toBe(0);
  });

  it('bitisi bildirilmeyen seans (RECONCILING 10+ dk)', async () => {
    const s = await session({ status: SessionStatus.RECONCILING, reconcilingAt: ago(2 * MIN) });
    expect(await alarms.sweep()).toBe(0); // henuz erken
    await prisma.washSession.update({
      where: { id: s.id },
      data: { reconcilingAt: ago(11 * MIN) },
    });
    expect(await alarms.sweep()).toBe(1);
    expect((await alarms.active())[0]).toMatchObject({
      key: 'sessions-reconciling',
      title: 'Bitisi bildirilmeyen seans: 1',
    });
  });

  it('ACK zaman asimi orani: son 30 dk icinde 3+', async () => {
    for (let i = 0; i < 2; i++)
      await session({
        status: SessionStatus.FAILED,
        endReason: 'ACK_TIMEOUT',
        endedAt: ago(5 * MIN),
      });
    expect(await alarms.sweep()).toBe(0);
    await session({
      status: SessionStatus.FAILED,
      endReason: 'ACK_TIMEOUT',
      endedAt: ago(1 * MIN),
    });
    await session({
      status: SessionStatus.FAILED,
      endReason: 'ACK_TIMEOUT',
      endedAt: ago(45 * MIN),
    }); // pencere disi
    expect(await alarms.sweep()).toBe(1);
    expect((await alarms.active())[0]).toMatchObject({ key: 'ack-timeouts', severity: 'WARNING' });
  });

  it('ACK zaman asimi orani: iade edilmeyen (ACK belirsiz) seanslar da sayilir, iki kez degil', async () => {
    const uncertain = async (over: Record<string, unknown> = {}) => {
      const s = await session({ status: SessionStatus.RECONCILING, ...over });
      await prisma.sessionTransition.create({
        data: {
          sessionId: s.id,
          fromState: SessionStatus.STARTING,
          toState: SessionStatus.RECONCILING,
          reason: 'ACK_UNCERTAIN',
          createdAt: ago(2 * MIN),
        },
      });
    };
    await uncertain({ reconcilingAt: ago(2 * MIN) });
    // Belirsiz kaldiktan sonra cihaz bosta cikti ve iade edildi: tek seans.
    await uncertain({
      status: SessionStatus.FAILED,
      endReason: 'ACK_TIMEOUT',
      endedAt: ago(1 * MIN),
    });
    expect(await alarms.sweep()).toBe(0);
    // Belirsiz kaldiktan sonra cihaz calistigini bildirdi ve seans bitti.
    await uncertain({
      status: SessionStatus.COMPLETED,
      startedAt: ago(2 * MIN),
      endedAt: ago(1 * MIN),
      endReason: 'DEVICE_COMPLETED',
      usedSeconds: 60,
      chargedKurus: 3000n,
    });
    expect(await alarms.sweep()).toBe(1);
    expect((await alarms.active())[0]).toMatchObject({ key: 'ack-timeouts' });
  });

  it('odeme takilmasi: iptali bekleyen kart odemesi ve belirsiz iade parcasi', async () => {
    const topUp = await prisma.cardTopUp.create({
      data: {
        userId,
        walletId,
        amountKurus: 5000,
        status: CardTopUpStatus.REVERSAL_PENDING,
        idempotencyKey: randomUUID(),
        createdAt: ago(20 * MIN),
      },
    });
    expect(topUp.id).toBeTruthy();
    expect(await alarms.sweep()).toBe(1);
    expect((await alarms.active())[0]).toMatchObject({
      key: 'payments-stuck',
      severity: 'CRITICAL',
    });

    const refundHold = await prisma.walletHold.create({
      data: { walletId, amountKurus: 100, source: 'SESSION', idempotencyKey: randomUUID() },
    });
    const request = await prisma.refundRequest.create({
      data: {
        userId,
        walletId,
        holdId: refundHold.id,
        reason: 'ACCOUNT_DELETION',
        amountKurus: 100,
        holderName: 'Test Kisi',
        allocation: [],
      },
    });
    await prisma.refundPayout.create({
      data: {
        refundRequestId: request.id,
        partIndex: 0,
        method: 'CARD',
        amountKurus: 100,
        status: RefundPayoutStatus.IN_FLIGHT,
      },
    });
    await prisma.refundPayout.updateMany({ data: { updatedAt: ago(20 * MIN) } });
    await alarms.sweep();
    expect((await alarms.active())[0]!.detail).toContain('1 iade parcasi');
  });

  it('cihaza gitmeyen komut (outbox 60+ sn)', async () => {
    await prisma.outboxEvent.create({
      data: { topic: 't', payload: {}, status: OutboxStatus.PENDING, createdAt: ago(2 * MIN) },
    });
    expect(await alarms.sweep()).toBe(1);
    expect((await alarms.active())[0]).toMatchObject({ key: 'outbox-backlog' });
  });

  it('MQTT kopuklugu 60 sn surerse alarm; baglaninca kapanir', async () => {
    mqtt.isConnected = false;
    expect(await alarms.sweep()).toBe(0); // Kopukluk yeni basladi
    advance(2 * MIN);
    await prisma.device.update({
      where: { deviceId: '4CC382C3CC1C' },
      data: { lastSeenAt: clock() },
    });
    expect(await alarms.sweep()).toBe(1);
    expect((await alarms.active())[0]).toMatchObject({ key: 'mqtt-down' });
    mqtt.isConnected = true;
    expect(await alarms.sweep()).toBe(0);
    expect(notifier.sent.map((n) => n.kind)).toEqual(['FIRING', 'RESOLVED']);
  });

  it('incelemeyi 1+ saat bekleyen seans; incelenmis olan sayilmaz', async () => {
    await session({
      status: SessionStatus.COMPLETED,
      usedSeconds: 10,
      chargedKurus: 500n,
      needsReview: true,
      endedAt: ago(90 * MIN),
    });
    await session({
      status: SessionStatus.COMPLETED,
      usedSeconds: 10,
      chargedKurus: 500n,
      needsReview: true,
      endedAt: ago(90 * MIN),
      reviewedAt: ago(1 * MIN),
    });
    await session({
      status: SessionStatus.COMPLETED,
      usedSeconds: 10,
      chargedKurus: 500n,
      needsReview: true,
      endedAt: ago(5 * MIN),
    });
    expect(await alarms.sweep()).toBe(1);
    expect((await alarms.active())[0]).toMatchObject({
      key: 'sessions-need-review',
      severity: 'WARNING',
    });
  });

  it('bildirim gonderilemese de alarm kaydi acilir ve tarama devam eder', async () => {
    notifier.failing = true;
    advance(10 * MIN);
    await expect(alarms.sweep()).resolves.toBe(1);
    expect(await alarms.active()).toHaveLength(1);
  });

  it('e-posta: konu ve icerik, alicida sir yok', async () => {
    const sent: { subject: string; text: string; to: string }[] = [];
    const email = new EmailAlertNotifier(
      { host: 'h', port: 587, secure: false, from: 'QWash <a@b.co>', to: 'ops@b.co' },
      {
        sendMail: (m: { subject: string; text: string; to: string }) => (
          sent.push(m),
          Promise.resolve()
        ),
      } as never,
    );
    await email.notify({
      kind: 'FIRING',
      severity: 'CRITICAL',
      title: 'Peron cihazi cevrimdisi: BAY-001',
      detail: 'Son mesaj 4 dk once',
      since: clock(),
    });
    expect(sent[0]!.to).toBe('ops@b.co');
    expect(sent[0]!.subject).toBe('[QWash ALARM KRITIK] Peron cihazi cevrimdisi: BAY-001');
    expect(sent[0]!.text).toContain('Son mesaj 4 dk once');
  });
});
