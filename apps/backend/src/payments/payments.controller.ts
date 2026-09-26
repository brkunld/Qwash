import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { StartTopUpRequestSchema, type TopUpOptions, type TopUpView } from '@qwash/contracts';
import type { Request, Response } from 'express';
import { AccessTokenGuard, CurrentUser } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/auth.service';
import { ZodBody } from '../http/api-envelope';
import { PaymentGateway } from './payment-gateway';
import { IdempotencyKeyRequiredError } from './payments.errors';
import { PaymentsService } from './payments.service';

export const CUSTOMER_APP_URL = Symbol('CUSTOMER_APP_URL');

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly payments: PaymentsService,
    @Inject(PaymentGateway) private readonly gateway: PaymentGateway | null,
    @Inject(CUSTOMER_APP_URL) private readonly customerAppUrl: string,
  ) {}

  @Get('topup-options')
  @UseGuards(AccessTokenGuard)
  topUpOptions(): Promise<TopUpOptions> {
    return this.payments.getTopUpOptions();
  }

  @Post('topup')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseGuards(AccessTokenGuard)
  startTopUp(
    @CurrentUser() user: AccessClaims,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodBody(StartTopUpRequestSchema)) body: { amountKurus: number },
    @Req() req: Request,
  ): Promise<TopUpView> {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 100) throw new IdempotencyKeyRequiredError();
    return this.payments.startTopUp({
      userId: user.userId,
      amountKurus: body.amountKurus,
      idempotencyKey: key,
      ip: req.ip ?? null,
    });
  }

  @Get('topups/:id')
  @UseGuards(AccessTokenGuard)
  getTopUp(
    @CurrentUser() user: AccessClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TopUpView> {
    return this.payments.getTopUp(user.userId, id);
  }

  /**
   * Iyzico odeme sayfasi bittiginde musterinin tarayicisi buraya form POST eder (token).
   * Govdeye guvenilmez: sonuc Iyzico'dan sorulur. Musteri her durumda PWA'daki sonuc
   * sayfasina yonlendirilir; o sayfa GET /payments/topups/:id ile durumu okur.
   */
  @Post('iyzico/callback')
  @SkipThrottle()
  async callback(@Body() body: unknown, @Res() res: Response): Promise<void> {
    const token = readToken(body);
    let topUpId: string | null = null;
    if (token) {
      try {
        topUpId = (await this.payments.completeByToken(token))?.id ?? null;
      } catch (error) {
        // Sonuc sorulamadi; mutabakat ve webhook daha sonra tamamlar.
        this.logger.warn({ err: error }, 'Iyzico callback: sonuc sorulamadi');
      }
    }
    const target = new URL('/wallet/topup-result', this.customerAppUrl);
    if (topUpId) target.searchParams.set('id', topUpId);
    res.redirect(303, target.toString());
  }

  /** Iyzico bildirimi (X-IYZ-SIGNATURE-V3). Imza gecerliyse sonuc Iyzico'dan sorulur. */
  @Post('webhook')
  @HttpCode(200)
  @SkipThrottle()
  async webhook(
    @Body() body: unknown,
    @Headers('x-iyz-signature-v3') signature: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.gateway?.verifyWebhook(body, signature)) {
      res.status(403).json({ success: false, error: { code: 'INVALID_SIGNATURE' } });
      return;
    }
    const token = readToken(body);
    if (token) {
      // Hata olursa 5xx doner; Iyzico 15 dk sonra tekrar dener, mutabakat da yakalar.
      await this.payments.completeByToken(token);
    }
    res.status(200).json({ success: true });
  }
}

function readToken(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const token = (body as { token?: unknown }).token;
  return typeof token === 'string' && token.length > 0 && token.length <= 200 ? token : null;
}
