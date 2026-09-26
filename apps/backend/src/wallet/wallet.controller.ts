import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { WalletView } from '@qwash/contracts';
import { AccessTokenGuard, CurrentUser } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletNotFoundError } from './wallet.errors';

@ApiTags('wallet')
@Controller('wallet')
@UseGuards(AccessTokenGuard)
export class WalletController {
  constructor(private readonly prisma: PrismaService) {}

  /** Musterinin bakiyesi. Kullanilabilir = bakiye - aktif seans blokeleri. */
  @Get()
  async get(@CurrentUser() user: AccessClaims): Promise<WalletView> {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId: user.userId } });
    if (!wallet) throw new WalletNotFoundError(`user:${user.userId}`);
    const balanceKurus = Number(wallet.balanceKurus);
    const holdKurus = Number(wallet.holdKurus);
    return { balanceKurus, holdKurus, availableKurus: balanceKurus - holdKurus };
  }
}
