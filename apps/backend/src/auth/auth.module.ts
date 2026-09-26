import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AuthController, COOKIE_SECURE } from './auth.controller';
import { AccessTokenGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { AuthWorker } from './auth.worker';
import { GoogleTokenVerifier, JoseGoogleTokenVerifier } from './google';
import { DevConsoleMailer, Mailer } from './mailer';
import { SmtpMailer } from './smtp-mailer';

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: Mailer,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Mailer => {
        const host = config.get('SMTP_HOST', { infer: true });
        if (host) {
          return new SmtpMailer({
            host,
            port: config.get('SMTP_PORT', { infer: true }),
            secure: config.get('SMTP_SECURE', { infer: true }),
            user: config.get('SMTP_USER', { infer: true }),
            password: config.get('SMTP_PASSWORD', { infer: true }),
            from: config.get('MAIL_FROM', { infer: true })!,
          });
        }
        if (config.get('NODE_ENV', { infer: true }) === 'production') {
          // SMTP tanimlanmadan production'da dogrulama/sifirlama calismaz.
          throw new Error('Production icin SMTP_HOST ve MAIL_FROM tanimlanmali (.env.example)');
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
    AuthWorker,
  ],
  exports: [AuthService, AccessTokenGuard, COOKIE_SECURE],
})
export class AuthModule {}
