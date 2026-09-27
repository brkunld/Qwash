import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { AlertNotifier } from './alarm.service';

export interface EmailAlertOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
  to: string;
}

const PREFIX = { FIRING: 'ALARM', REMINDER: 'HATIRLATMA', RESOLVED: 'COZULDU' } as const;

/** Alarm e-postasi (SMTP). Icinde sir veya kisisel veri yoktur. */
export class EmailAlertNotifier extends AlertNotifier {
  private readonly logger = new Logger(EmailAlertNotifier.name);
  private readonly transport: Transporter;

  constructor(
    private readonly options: EmailAlertOptions,
    transport?: Transporter,
  ) {
    super();
    this.transport =
      transport ??
      createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure,
        auth: options.user ? { user: options.user, pass: options.password } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        requireTLS: !options.secure,
      });
  }

  async notify(alert: Parameters<AlertNotifier['notify']>[0]): Promise<void> {
    const critical = alert.severity === 'CRITICAL' ? ' KRITIK' : '';
    const subject = `[QWash ${PREFIX[alert.kind]}${critical}] ${alert.title}`;
    const text = [
      alert.title,
      '',
      alert.detail,
      '',
      `Baslangic: ${alert.since.toISOString()}`,
      `Durum: ${alert.kind}`,
      '',
      'Acik alarmlar: Admin paneli veya GET /api/v1/admin/alarms',
    ].join('\n');
    await this.transport.sendMail({ from: this.options.from, to: this.options.to, subject, text });
    this.logger.log(`Alarm e-postasi gonderildi (${alert.kind})`);
  }
}

/** E-posta ayarli degilse: alarm yalniz loga ve GET /admin/alarms'a yazilir. */
export class NoopAlertNotifier extends AlertNotifier {
  notify(): Promise<void> {
    return Promise.resolve();
  }
}
