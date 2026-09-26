import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { CorsIoAdapter } from '../realtime/cors-io.adapter';
import { ApiErrorFilter, EnvelopeInterceptor } from './api-envelope';

/** main.ts ve HTTP testleri ayni ayarla calissin diye ortak kurulum. */
export function configureApp(app: INestApplication, corsOrigins: string[]): void {
  app.setGlobalPrefix('api/v1');
  // Guvenlik basliklari (SECURITY.md 4). API yalniz JSON dondurur; CSP en dar haliyle.
  // Swagger arayuzu (yalniz gelistirme) satir ici script kullandigi icin CSP'si kendi yolunda
  // gevsetilmez; production'da Swagger zaten kapali (main.ts).
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      frameguard: { action: 'deny' },
    }),
  );
  app.use(cookieParser());
  // Refresh cookie'si icin credentials gerekir; yalniz listelenen kaynaklara izin verilir.
  app.enableCors({ origin: corsOrigins, credentials: true });
  app.useGlobalFilters(new ApiErrorFilter());
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  app.useWebSocketAdapter(new CorsIoAdapter(app, corsOrigins));
}
