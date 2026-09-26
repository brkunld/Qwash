import { hostname } from 'node:os';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { MqttService } from '../iot/mqtt.service';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { AuthModule } from '../auth/auth.module';
import { BayClaimService } from './bay-claim.service';
import { BayController, SessionController } from './session.controller';
import { SessionQueries } from './session.queries';
import { SessionService } from './session.service';
import { SessionWorker } from './session.worker';

@Module({
  imports: [WalletModule, AuthModule],
  controllers: [BayController, SessionController],
  providers: [
    {
      provide: SessionQueries,
      inject: [PrismaService, SessionService],
      useFactory: (prisma: PrismaService, sessions: SessionService) =>
        new SessionQueries(prisma, sessions),
    },
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
      provide: BayClaimService,
      inject: [PrismaService, SessionService, OutboxService],
      useFactory: (prisma: PrismaService, sessions: SessionService, outbox: OutboxService) =>
        new BayClaimService(prisma, sessions, outbox),
    },
    {
      provide: MqttService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new MqttService(config.get('MQTT_URL', { infer: true }), `qwash-backend-${hostname()}`),
    },
    {
      provide: SessionWorker,
      inject: [MqttService, OutboxService, SessionService, BayClaimService],
      useFactory: (
        mqtt: MqttService,
        outbox: OutboxService,
        sessions: SessionService,
        claims: BayClaimService,
      ) => new SessionWorker(mqtt, outbox, sessions, { outboxMs: 250, sweepMs: 1_000 }, claims),
    },
  ],
  exports: [SessionService, SessionQueries],
})
export class SessionModule {}
