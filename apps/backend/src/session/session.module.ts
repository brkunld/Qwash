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
import { defaultFirmwareDir, DeviceOpsService } from './device-ops.service';
import { FIRMWARE_DIR, FirmwareController } from './firmware.controller';
import { BayController, SessionController } from './session.controller';
import { SessionQueries } from './session.queries';
import { SessionService } from './session.service';
import { SessionWorker } from './session.worker';

@Module({
  imports: [WalletModule, AuthModule],
  controllers: [BayController, SessionController, FirmwareController],
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
      provide: FIRMWARE_DIR,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('FIRMWARE_DIR', { infer: true }) ?? defaultFirmwareDir(),
    },
    {
      provide: DeviceOpsService,
      inject: [PrismaService, SessionService, OutboxService, ConfigService],
      useFactory: (
        prisma: PrismaService,
        sessions: SessionService,
        outbox: OutboxService,
        config: ConfigService<Env, true>,
      ) =>
        new DeviceOpsService(prisma, sessions, outbox, {
          qrBase:
            config.get('DEVICE_QR_BASE', { infer: true }) ??
            `${config.get('CUSTOMER_APP_URL', { infer: true }).replace(/\/$/, '')}/b/`,
          deviceApiUrl:
            config.get('DEVICE_API_URL', { infer: true }) ??
            config.get('API_PUBLIC_URL', { infer: true }),
        }),
    },
    {
      provide: MqttService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new MqttService(config.get('MQTT_URL', { infer: true }), `qwash-backend-${hostname()}`),
    },
    {
      provide: SessionWorker,
      inject: [MqttService, OutboxService, SessionService, BayClaimService, DeviceOpsService],
      useFactory: (
        mqtt: MqttService,
        outbox: OutboxService,
        sessions: SessionService,
        claims: BayClaimService,
        deviceOps: DeviceOpsService,
      ) =>
        new SessionWorker(mqtt, outbox, sessions, { outboxMs: 250, sweepMs: 1_000 }, [
          { name: 'claims', sweep: () => claims.sweep() },
          { name: 'firmware', sweep: () => deviceOps.sweep() },
        ]),
    },
  ],
  exports: [SessionService, SessionQueries, MqttService, DeviceOpsService],
})
export class SessionModule {}
