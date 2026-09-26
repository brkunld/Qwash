import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { Env } from './config/env';
import { configureApp } from './http/configure-app';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  configureApp(
    app,
    config
      .get('CORS_ORIGINS', { infer: true })
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder().setTitle('QWASH API').setVersion('0.0.0').build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  await app.listen(config.get('BACKEND_PORT', { infer: true }));
}

void bootstrap();
