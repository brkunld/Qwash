import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { WalletModule } from '../wallet/wallet.module';
import { WalletService } from '../wallet/wallet.service';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';

@Module({
  imports: [AuthModule, WalletModule],
  controllers: [AccountController],
  providers: [
    {
      provide: AccountService,
      inject: [PrismaService, WalletService],
      useFactory: (prisma: PrismaService, wallets: WalletService) =>
        new AccountService(prisma, wallets),
    },
  ],
})
export class AccountModule {}
