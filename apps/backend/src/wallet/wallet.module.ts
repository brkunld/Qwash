import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

@Module({
  imports: [AuthModule],
  controllers: [WalletController],
  providers: [
    {
      provide: WalletService,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new WalletService(prisma),
    },
  ],
  exports: [WalletService],
})
export class WalletModule {}
