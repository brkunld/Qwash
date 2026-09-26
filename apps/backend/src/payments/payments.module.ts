import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { IyzicoGateway } from './iyzico.gateway';
import { PaymentGateway } from './payment-gateway';
import { CUSTOMER_APP_URL, PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentsWorker } from './payments.worker';

@Module({
  imports: [AuthModule, WalletModule],
  controllers: [PaymentsController],
  providers: [
    {
      provide: PaymentGateway,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): PaymentGateway | null => {
        const apiKey = config.get('IYZICO_API_KEY', { infer: true });
        const secretKey = config.get('IYZICO_SECRET_KEY', { infer: true });
        if (!apiKey || !secretKey) return null;
        return new IyzicoGateway({
          apiKey,
          secretKey,
          baseUrl: config.get('IYZICO_BASE_URL', { infer: true }),
        });
      },
    },
    {
      provide: CUSTOMER_APP_URL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('CUSTOMER_APP_URL', { infer: true }),
    },
    {
      provide: PaymentsService,
      inject: [PrismaService, WalletService, PaymentGateway, ConfigService],
      useFactory: (
        prisma: PrismaService,
        wallets: WalletService,
        gateway: PaymentGateway | null,
        config: ConfigService<Env, true>,
      ) =>
        new PaymentsService(prisma, wallets, {
          gateway,
          apiPublicUrl: config.get('API_PUBLIC_URL', { infer: true }),
        }),
    },
    PaymentsWorker,
  ],
})
export class PaymentsModule {}
