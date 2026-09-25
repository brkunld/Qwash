import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  type AuthResponse,
  ForgotPasswordRequestSchema,
  GoogleLoginRequestSchema,
  LoginRequestSchema,
  type Me,
  RegisterRequestSchema,
  ResetPasswordRequestSchema,
  TokenRequestSchema,
  UpdateProfileRequestSchema,
} from '@qwash/contracts';
import type { Request, Response } from 'express';
import { ZodBody } from '../http/api-envelope';
import { AccessTokenGuard, CurrentUser } from './auth.guard';
import { AuthService } from './auth.service';
import type { AccessClaims, IssuedSession } from './auth.service';

// Refresh token yalniz auth yollarina giden HTTP-only cookie'de tasinir (SECURITY.md 1.1).
export const REFRESH_COOKIE = 'qwash_rt';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
export const COOKIE_SECURE = Symbol('COOKIE_SECURE');

// Kaba kuvvet korumasi: IP basina 15 dakikada 10 istek (API.md "Rate limit").
const STRICT = { default: { limit: 10, ttl: 15 * 60 * 1000 } };

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(COOKIE_SECURE) private readonly cookieSecure: boolean,
  ) {}

  @Post('auth/register')
  @Throttle(STRICT)
  async register(
    @Body(new ZodBody(RegisterRequestSchema))
    body: { email: string; password: string; fullName: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(res, await this.auth.register(body));
  }

  @Post('auth/login')
  @HttpCode(200)
  @Throttle(STRICT)
  async login(
    @Body(new ZodBody(LoginRequestSchema)) body: { email: string; password: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(res, await this.auth.login(body));
  }

  @Post('auth/google')
  @HttpCode(200)
  @Throttle(STRICT)
  async google(
    @Body(new ZodBody(GoogleLoginRequestSchema)) body: { idToken: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(res, await this.auth.loginWithGoogle(body.idToken));
  }

  @Post('auth/refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    try {
      return this.respond(res, await this.auth.refresh(readRefreshCookie(req) ?? ''));
    } catch (error) {
      this.clearCookie(res);
      throw error;
    }
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(readRefreshCookie(req));
    this.clearCookie(res);
  }

  @Post('auth/verify-email')
  @HttpCode(204)
  @Throttle(STRICT)
  async verifyEmail(@Body(new ZodBody(TokenRequestSchema)) body: { token: string }): Promise<void> {
    await this.auth.verifyEmail(body.token);
  }

  @Post('auth/resend-verification')
  @HttpCode(204)
  @Throttle({ default: { limit: 3, ttl: 15 * 60 * 1000 } })
  @UseGuards(AccessTokenGuard)
  async resendVerification(@CurrentUser() user: AccessClaims): Promise<void> {
    await this.auth.resendVerification(user.userId);
  }

  @Post('auth/forgot-password')
  @HttpCode(204)
  @Throttle({ default: { limit: 5, ttl: 15 * 60 * 1000 } })
  async forgotPassword(
    @Body(new ZodBody(ForgotPasswordRequestSchema)) body: { email: string },
  ): Promise<void> {
    await this.auth.forgotPassword(body.email);
  }

  @Post('auth/reset-password')
  @HttpCode(204)
  @Throttle(STRICT)
  async resetPassword(
    @Body(new ZodBody(ResetPasswordRequestSchema)) body: { token: string; password: string },
  ): Promise<void> {
    await this.auth.resetPassword(body.token, body.password);
  }

  @Get('me')
  @UseGuards(AccessTokenGuard)
  me(@CurrentUser() user: AccessClaims): Promise<Me> {
    return this.auth.getMe(user.userId);
  }

  @Patch('me/profile')
  @UseGuards(AccessTokenGuard)
  updateProfile(
    @CurrentUser() user: AccessClaims,
    @Body(new ZodBody(UpdateProfileRequestSchema)) body: { fullName: string },
  ): Promise<Me> {
    return this.auth.updateProfile(user.userId, body);
  }

  private respond(res: Response, session: IssuedSession): AuthResponse {
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      expires: session.refreshTokenExpiresAt,
    });
    return {
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
      user: session.user,
    };
  }

  private clearCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    });
  }
}

function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
