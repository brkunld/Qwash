import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaymentGateway } from '../payments/payment-gateway';
import { PaymentsModule } from '../payments/payments.module';
import { PrismaService } from '../prisma/prisma.service';
import { SessionModule } from '../session/session.module';
import { SessionService } from '../session/session.service';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { OpsService } from './ops.service';
import { ProgramService } from './program.service';
import { RefundAdminService } from './refund-admin.service';

@Module({
  imports: [AuthModule, WalletModule, PaymentsModule, SessionModule],
  controllers: [AdminController],
  providers: [
    AdminGuard,
    {
      provide: ProgramService,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new ProgramService(prisma),
    },
    {
      provide: OpsService,
      inject: [PrismaService, SessionService, WalletService],
      useFactory: (prisma: PrismaService, sessions: SessionService, wallets: WalletService) =>
        new OpsService(prisma, sessions, wallets),
    },
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
