import { Logger } from '@nestjs/common';
import type { AdminAlarm } from '@qwash/contracts';
import { PrismaClient } from '../generated/prisma/client';
import {
  CardTopUpStatus,
  OutboxStatus,
  RefundPayoutStatus,
  SessionStatus,
} from '../generated/prisma/enums';

export type AlarmSeverity = 'WARNING' | 'CRITICAL';

export interface Firing {
  key: string;
  severity: AlarmSeverity;
  title: string;
  detail: string;
}

/** Bildirim kanali. Testlerde sahte, uretimde log + (varsa) e-posta. */
export abstract class AlertNotifier {
  abstract notify(alert: {
    kind: 'FIRING' | 'REMINDER' | 'RESOLVED';
    severity: AlarmSeverity;
    title: string;
    detail: string;
    since: Date;
  }): Promise<void>;
}

export interface AlarmThresholds {
  /** Cihazdan bu kadar suredir mesaj yoksa (bakimda degilse) alarm. */
  deviceOfflineMs: number;
  /** RECONCILING'de bu kadar bekleyen seans: bloke duruyor, cihaz bitis bildirmedi. */
  reconcilingMs: number;
  /** Son `ackWindowMs` icinde bu kadar ACK zaman asimi. */
  ackTimeouts: number;
  ackWindowMs: number;
  /** Bu kadar suredir yayinlanamayan komut: broker/yayin sorunu. */
  outboxBacklogMs: number;
  /** MQTT bu kadar suredir bagli degil. */
  mqttDownMs: number;
  /** Alinan ama iptali/iadesi bitmeyen kart odemesi, belirsiz iade parcasi. */
  paymentStuckMs: number;
  /** Incelemeyi bekleyen seans. */
  reviewMs: number;
  /** Acik alarm icin hatirlatma araligi. */
  repeatMs: number;
}

const MIN = 60_000;
export const DEFAULT_ALARM_THRESHOLDS: AlarmThresholds = {
  deviceOfflineMs: 3 * MIN,
  reconcilingMs: 10 * MIN,
  ackTimeouts: 3,
  ackWindowMs: 30 * MIN,
  outboxBacklogMs: 60_000,
  mqttDownMs: 60_000,
  paymentStuckMs: 15 * MIN,
  reviewMs: 60 * MIN,
  repeatMs: 6 * 60 * MIN,
};

/** MQTT baglanti durumu (MqttService uygular). */
export interface MqttStatus {
  readonly isConnected: boolean;
}

/**
 * Temel alarmlar (Faz 7 izleme). Her tur kosullari hesaplar ve `Alarm` tablosuyla karsilastirir:
 * yeni kosul -> kayit + bildirim; suren kosul -> yalniz `repeatMs`'de hatirlatma; biten kosul ->
 * kapanis + bildirim. Boylece bir sorun e-posta yagdirmaz ve backend yeniden basladiginda ayni
 * alarm ikinci kez "yeni" sayilmaz. Tum alarmlar ayrica loga yazilir.
 */
export class AlarmService {
  private readonly logger = new Logger(AlarmService.name);
  private mqttDownSince: number | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly mqtt: MqttStatus,
    private readonly notifier: AlertNotifier,
    private readonly clock: () => Date = () => new Date(),
    private readonly t: AlarmThresholds = DEFAULT_ALARM_THRESHOLDS,
  ) {}

  /** Acik alarmlar (admin paneli / smoke). */
  async active(): Promise<AdminAlarm[]> {
    const rows = await this.prisma.alarm.findMany({
      where: { resolvedAt: null },
      orderBy: [{ severity: 'asc' }, { firingSince: 'asc' }],
    });
    return rows.map((r) => ({
      key: r.key,
      severity: r.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
      title: r.title,
      detail: r.detail,
      firingSince: r.firingSince.toISOString(),
    }));
  }

  /** Bir tarama turu. Donen: acik alarm sayisi. */
  async sweep(): Promise<number> {
    const now = this.clock();
    const firing = await this.evaluate(now);
    const byKey = new Map(firing.map((f) => [f.key, f]));
    const open = await this.prisma.alarm.findMany({ where: { resolvedAt: null } });
    const openByKey = new Map(open.map((a) => [a.key, a]));

    for (const f of firing) {
      const existing = openByKey.get(f.key);
      if (!existing) {
        const row = await this.prisma.alarm.upsert({
          where: { key: f.key },
          create: { ...f, firingSince: now, lastNotifiedAt: now },
          update: { ...f, firingSince: now, lastNotifiedAt: now, resolvedAt: null },
        });
        await this.send('FIRING', f, row.firingSince);
        continue;
      }
      const due =
        !existing.lastNotifiedAt ||
        now.getTime() - existing.lastNotifiedAt.getTime() >= this.t.repeatMs;
      await this.prisma.alarm.update({
        where: { key: f.key },
        data: {
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          ...(due ? { lastNotifiedAt: now } : {}),
        },
      });
      if (due) await this.send('REMINDER', f, existing.firingSince);
    }
    for (const a of open) {
      if (byKey.has(a.key)) continue;
      await this.prisma.alarm.update({ where: { key: a.key }, data: { resolvedAt: now } });
      await this.send(
        'RESOLVED',
        {
          key: a.key,
          severity: a.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
          title: a.title,
          detail: a.detail,
        },
        a.firingSince,
      );
    }
    return firing.length;
  }

  /** Kosullari hesaplar (yazmaz). */
  async evaluate(now: Date): Promise<Firing[]> {
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const out: Firing[] = [];

    // 1) Cihaz cevrimdisi (bakimdaki/kapali peronda beklenen durumdur; gece cihaz kapatilabilir)
    const bays = await this.prisma.bay.findMany({
      where: { outOfServiceKind: null, device: { isNot: null } },
      include: { device: true },
    });
    for (const bay of bays) {
      const d = bay.device!;
      const silentMs = now.getTime() - d.lastSeenAt.getTime();
      if (silentMs > this.t.deviceOfflineMs) {
        out.push({
          key: `device-offline:${bay.bayCode}`,
          severity: 'CRITICAL',
          title: `Peron cihazi cevrimdisi: ${bay.bayCode}`,
          detail: `Son mesaj ${Math.round(silentMs / 60_000)} dk once (${d.lastSeenAt.toISOString()}), cihaz ${d.deviceId}, surum ${d.firmwareVersion ?? '?'}. Musteri bu peronda baslatamaz. docs/RUNBOOK.md bolum 3.`,
        });
      }
    }

    // 2) Bitisi bildirilmeyen seans (bloke duruyor)
    const reconciling = await this.prisma.washSession.count({
      where: {
        status: SessionStatus.RECONCILING,
        reconcilingAt: { lte: ago(this.t.reconcilingMs) },
      },
    });
    if (reconciling > 0) {
      out.push({
        key: 'sessions-reconciling',
        severity: 'CRITICAL',
        title: `Bitisi bildirilmeyen seans: ${reconciling}`,
        detail: `${reconciling} seans ${Math.round(this.t.reconcilingMs / 60_000)}+ dk RECONCILING'de; bloke duruyor. 30 dk sonra otomatik kapanir. docs/RUNBOOK.md bolum 5.`,
      });
    }

    // 3) ACK zaman asimi orani
    const acks = await this.prisma.washSession.count({
      where: { endReason: 'ACK_TIMEOUT', endedAt: { gte: ago(this.t.ackWindowMs) } },
    });
    if (acks >= this.t.ackTimeouts) {
      out.push({
        key: 'ack-timeouts',
        severity: 'WARNING',
        title: `ACK zaman asimi: son ${Math.round(this.t.ackWindowMs / 60_000)} dk'da ${acks}`,
        detail: `Cihazlar START komutuna 10 sn icinde cevap vermiyor; bloke iade edildi. Cihaz/Wi-Fi/broker sorunu olabilir. docs/RUNBOOK.md bolum 4.`,
      });
    }

    // 4) Odeme / iade takilmasi
    const reversals = await this.prisma.cardTopUp.count({
      where: {
        status: CardTopUpStatus.REVERSAL_PENDING,
        createdAt: { lte: ago(this.t.paymentStuckMs) },
      },
    });
    const payouts = await this.prisma.refundPayout.count({
      where: {
        OR: [
          { status: RefundPayoutStatus.IN_FLIGHT, updatedAt: { lte: ago(this.t.paymentStuckMs) } },
          { status: RefundPayoutStatus.FAILED },
        ],
      },
    });
    if (reversals > 0 || payouts > 0) {
      out.push({
        key: 'payments-stuck',
        severity: 'CRITICAL',
        title: 'Odeme/iade isleminde takilma',
        detail: `${reversals} kart odemesi iptal/iade bekliyor, ${payouts} iade parcasi belirsiz/basarisiz. Admin > Iade talepleri. docs/RUNBOOK.md bolum 8-9.`,
      });
    }

    // 5) Yayinlanamayan komutlar
    const backlog = await this.prisma.outboxEvent.count({
      where: { status: OutboxStatus.PENDING, createdAt: { lte: ago(this.t.outboxBacklogMs) } },
    });
    if (backlog > 0) {
      out.push({
        key: 'outbox-backlog',
        severity: 'CRITICAL',
        title: `Cihaza gitmeyen komut: ${backlog}`,
        detail: `${backlog} komut ${Math.round(this.t.outboxBacklogMs / 1000)}+ sn'dir yayinlanamadi; MQTT broker'a baglanti sorunu olabilir.`,
      });
    }

    // 6) MQTT kopuklugu
    if (this.mqtt.isConnected) {
      this.mqttDownSince = null;
    } else {
      this.mqttDownSince ??= now.getTime();
      if (now.getTime() - this.mqttDownSince >= this.t.mqttDownMs) {
        out.push({
          key: 'mqtt-down',
          severity: 'CRITICAL',
          title: 'MQTT broker baglantisi yok',
          detail: `Backend ${Math.round((now.getTime() - this.mqttDownSince) / 1000)} sn'dir broker'a bagli degil; cihazlarla komut/ACK akisi durdu (ACK gelmeyen seanslar iade edilir). docs/RUNBOOK.md bolum 10.`,
        });
      }
    }

    // 7) Uzun suredir bekleyen inceleme
    const review = await this.prisma.washSession.count({
      where: { needsReview: true, reviewedAt: null, endedAt: { lte: ago(this.t.reviewMs) } },
    });
    if (review > 0) {
      out.push({
        key: 'sessions-need-review',
        severity: 'WARNING',
        title: `Incelenmeyi bekleyen seans: ${review}`,
        detail: `${review} seans ${Math.round(this.t.reviewMs / 60_000)}+ dk'dir Admin > Inceleme'de. docs/RUNBOOK.md bolum 6.`,
      });
    }
    return out;
  }

  private async send(
    kind: 'FIRING' | 'REMINDER' | 'RESOLVED',
    f: Firing,
    since: Date,
  ): Promise<void> {
    const line = { key: f.key, severity: f.severity, kind };
    if (kind === 'RESOLVED') this.logger.log(line, `Alarm kapandi: ${f.title}`);
    else if (f.severity === 'CRITICAL') this.logger.error(line, `ALARM: ${f.title}`);
    else this.logger.warn(line, `ALARM: ${f.title}`);
    try {
      await this.notifier.notify({
        kind,
        severity: f.severity,
        title: f.title,
        detail: f.detail,
        since,
      });
    } catch (err) {
      // Bildirim hatasi izlemeyi durdurmaz (alarm kaydi ve log zaten yazildi).
      this.logger.error({ err, key: f.key }, 'Alarm bildirimi gonderilemedi');
    }
  }
}
