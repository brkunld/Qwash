import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AuthController, COOKIE_SECURE } from './auth.controller';
import { AccessTokenGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { GoogleTokenVerifier, JoseGoogleTokenVerifier } from './google';
import { DevConsoleMailer, Mailer } from './mailer';

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: Mailer,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Mailer => {
        if (config.get('NODE_ENV', { infer: true }) === 'production') {
          // E-posta saglayicisi secilmeden production'da dogrulama/sifirlama calismaz.
          throw new Error('Production icin e-posta saglayicisi tanimlanmadi (auth/mailer.ts)');
        }
        return new DevConsoleMailer();
      },
    },
    {
      provide: GoogleTokenVerifier,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): GoogleTokenVerifier | null => {
        const clientId = config.get('GOOGLE_CLIENT_ID', { infer: true });
        return clientId ? new JoseGoogleTokenVerifier(clientId) : null;
      },
    },
    {
      provide: COOKIE_SECURE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('NODE_ENV', { infer: true }) === 'production',
    },
    {
      provide: AuthService,
      inject: [PrismaService, ConfigService, Mailer, GoogleTokenVerifier],
      useFactory: (
        prisma: PrismaService,
        config: ConfigService<Env, true>,
        mailer: Mailer,
        google: GoogleTokenVerifier | null,
      ) =>
        new AuthService(prisma, {
          accessSecret: config.get('JWT_ACCESS_SECRET', { infer: true }),
          customerAppUrl: config.get('CUSTOMER_APP_URL', { infer: true }),
          mailer,
          google,
        }),
    },
    AccessTokenGuard,
  ],
  exports: [AuthService, AccessTokenGuard],
})
export class AuthModule {}
