import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaymentGateway } from '../payments/payment-gateway';
import { PaymentsModule } from '../payments/payments.module';
import { PrismaService } from '../prisma/prisma.service';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { RefundAdminService } from './refund-admin.service';

@Module({
  imports: [AuthModule, WalletModule, PaymentsModule],
  controllers: [AdminController],
  providers: [
    AdminGuard,
    {
      provide: AdminService,
      inject: [PrismaService, WalletService],
      useFactory: (prisma: PrismaService, wallets: WalletService) =>
        new AdminService(prisma, wallets),
    },
    {
      provide: RefundAdminService,
      inject: [PrismaService, WalletService, PaymentGateway],
      useFactory: (prisma: PrismaService, wallets: WalletService, gateway: PaymentGateway | null) =>
        new RefundAdminService(prisma, wallets, { gateway }),
    },
  ],
})
export class AdminModule {}
