import { Body, Controller, Get, HttpCode, Inject, Post, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  DeleteAccountRequestSchema,
  type DeleteAccountResponse,
  type DeletionPreview,
} from '@qwash/contracts';
import type { Response } from 'express';
import { COOKIE_SECURE, REFRESH_COOKIE, REFRESH_COOKIE_PATH } from '../auth/auth.controller';
import { AccessTokenGuard, CurrentUser } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/auth.service';
import { ZodBody } from '../http/api-envelope';
import { AccountService } from './account.service';
import type { DeleteAccountInput } from './account.service';

@ApiTags('account')
@Controller('me')
@UseGuards(AccessTokenGuard)
export class AccountController {
  constructor(
    private readonly accounts: AccountService,
    @Inject(COOKIE_SECURE) private readonly cookieSecure: boolean,
  ) {}

  /** Silme ekrani: bakiye, FIFO dagilimi, IBAN gerekip gerekmedigi, engeller. */
  @Get('deletion-preview')
  preview(@CurrentUser() user: AccessClaims): Promise<DeletionPreview> {
    return this.accounts.previewDeletion(user.userId);
  }

  /** Hesabi anonimlestirir; bakiye varsa feragat eder veya iade talebi olusturur. */
  @Post('delete')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 15 * 60 * 1000 } })
  async delete(
    @CurrentUser() user: AccessClaims,
    @Body(new ZodBody(DeleteAccountRequestSchema)) body: DeleteAccountInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeleteAccountResponse> {
    const result = await this.accounts.deleteAccount(user.userId, body);
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    });
    return result;
  }
}
