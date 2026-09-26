import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { ApiErrorFilter, EnvelopeInterceptor } from './api-envelope';

/** main.ts ve HTTP testleri ayni ayarla calissin diye ortak kurulum. */
export function configureApp(app: INestApplication, corsOrigins: string[]): void {
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  // Refresh cookie'si icin credentials gerekir; yalniz listelenen kaynaklara izin verilir.
  app.enableCors({ origin: corsOrigins, credentials: true });
  app.useGlobalFilters(new ApiErrorFilter());
  app.useGlobalInterceptors(new EnvelopeInterceptor());
}
