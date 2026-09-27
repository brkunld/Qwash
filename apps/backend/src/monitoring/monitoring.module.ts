import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { MqttService } from '../iot/mqtt.service';
import { PrismaService } from '../prisma/prisma.service';
import { SessionModule } from '../session/session.module';
import { AlarmService, AlertNotifier } from './alarm.service';
import { AlarmWorker } from './alarm.worker';
import { EmailAlertNotifier, NoopAlertNotifier } from './email-alert-notifier';

@Module({
  imports: [SessionModule],
  providers: [
    {
      provide: AlertNotifier,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): AlertNotifier => {
        const to = config.get('ALERT_EMAIL', { infer: true });
        const host = config.get('SMTP_HOST', { infer: true });
        const from = config.get('MAIL_FROM', { infer: true });
        if (!to || !host || !from) return new NoopAlertNotifier();
        return new EmailAlertNotifier({
          host,
          port: config.get('SMTP_PORT', { infer: true }),
          secure: config.get('SMTP_SECURE', { infer: true }),
          user: config.get('SMTP_USER', { infer: true }),
          password: config.get('SMTP_PASSWORD', { infer: true }),
          from,
          to,
        });
      },
    },
    {
      provide: AlarmService,
      inject: [PrismaService, MqttService, AlertNotifier],
      useFactory: (prisma: PrismaService, mqtt: MqttService, notifier: AlertNotifier) =>
        new AlarmService(prisma, mqtt, notifier),
    },
    {
      provide: AlarmWorker,
      inject: [AlarmService],
      useFactory: (alarms: AlarmService) => new AlarmWorker(alarms),
    },
  ],
  exports: [AlarmService],
})
export class MonitoringModule {}
