import { hostname } from 'node:os';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { MqttService } from '../iot/mqtt.service';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { SessionService } from './session.service';
import { SessionWorker } from './session.worker';

@Module({
  imports: [WalletModule],
  providers: [
    {
      provide: OutboxService,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new OutboxService(prisma),
    },
    {
      provide: SessionService,
      inject: [PrismaService, WalletService, OutboxService],
      useFactory: (prisma: PrismaService, wallets: WalletService, outbox: OutboxService) =>
        new SessionService(prisma, wallets, outbox),
    },
    {
      provide: MqttService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new MqttService(config.get('MQTT_URL', { infer: true }), `qwash-backend-${hostname()}`),
    },
    {
      provide: SessionWorker,
      inject: [MqttService, OutboxService, SessionService],
      useFactory: (mqtt: MqttService, outbox: OutboxService, sessions: SessionService) =>
        new SessionWorker(mqtt, outbox, sessions, { outboxMs: 250, sweepMs: 1_000 }),
    },
  ],
  exports: [SessionService],
})
export class SessionModule {}
