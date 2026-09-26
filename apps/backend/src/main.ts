import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { Env } from './config/env';
import { configureApp } from './http/configure-app';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  // Hop sayisi: X-Forwarded-For'un yalniz guvenilen vekilin ekledigi kismi okunur.
  app.set('trust proxy', config.get('TRUST_PROXY', { infer: true }));
  configureApp(
    app,
    config
      .get('CORS_ORIGINS', { infer: true })
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  app.enableShutdownHooks();

  // API haritasi disariya acilmaz; yalniz gelistirme/test.
  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const swaggerConfig = new DocumentBuilder().setTitle('QWASH API').setVersion('0.0.0').build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  }

  await app.listen(config.get('BACKEND_PORT', { infer: true }));
}

void bootstrap();
