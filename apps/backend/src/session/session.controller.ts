import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  StartSessionRequestSchema,
  type BayView,
  type SessionView,
  type StartSessionRequest,
} from '@qwash/contracts';
import { AccessTokenGuard, CurrentUser } from '../auth/auth.guard';
import type { AccessClaims } from '../auth/auth.service';
import { ZodBody } from '../http/api-envelope';
import { IdempotencyKeyRequiredError } from '../payments/payments.errors';
import { BayNotFoundError } from './session.errors';
import { SessionQueries } from './session.queries';
import { SessionService } from './session.service';

// QR icerigi kisa bir peron kodudur (Orn: "BAY-001"); baska bir sey sorguya gitmez.
const BAY_CODE = /^[A-Za-z0-9_-]{1,64}$/;

@ApiTags('bays')
@Controller('bays')
export class BayController {
  constructor(private readonly queries: SessionQueries) {}

  /**
   * QR okutulunca "Peron X'e baglaniyorsunuz" onay ekrani. Giris gerektirmez: musteri
   * once hangi perona baglandigini gorur, sonra giris yapar (ROADMAP Faz 5).
   */
  @Get(':bayCode')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  getBay(@Param('bayCode') bayCode: string): Promise<BayView> {
    if (!BAY_CODE.test(bayCode)) throw new BayNotFoundError(bayCode.slice(0, 64));
    return this.queries.getBay(bayCode);
  }
}

@ApiTags('sessions')
@Controller('sessions')
@UseGuards(AccessTokenGuard)
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly queries: SessionQueries,
  ) {}

  /** HOLD + START (two-phase ACK). Donen seans STARTING'dir; sonucu Socket.IO bildirir. */
  @Post()
  @Throttle({ default: { limit: 3, ttl: 30_000 } })
  async start(
    @CurrentUser() user: AccessClaims,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodBody(StartSessionRequestSchema)) body: StartSessionRequest,
  ): Promise<SessionView> {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 100) throw new IdempotencyKeyRequiredError();
    const session = await this.sessions.start({
      userId: user.userId,
      bayCode: body.bayCode,
      programCode: body.programCode,
      durationSec: body.durationSec,
      // Anahtar kullaniciya baglanir: baska kullanicinin anahtariyla cakisma olmaz.
      idempotencyKey: `${user.userId}:${key}`,
    });
    return this.queries.getSession(user.userId, session.id);
  }

  /** Arka plandan donen PWA durumu buradan geri yukler; aktif seans yoksa null. */
  @Get('active')
  active(@CurrentUser() user: AccessClaims): Promise<SessionView | null> {
    return this.queries.getActive(user.userId);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AccessClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SessionView> {
    return this.queries.getSession(user.userId, id);
  }

  /** Erken durdurma. Tahsilat cihaz bitisi bildirince yapilir (durdurma ani tavandir). */
  @Post(':id/stop')
  @HttpCode(200)
  async stop(
    @CurrentUser() user: AccessClaims,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SessionView> {
    await this.sessions.requestStop(id, user.userId);
    return this.queries.getSession(user.userId, id);
  }
}
