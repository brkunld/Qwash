import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from './wallet.service';

@Module({
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
