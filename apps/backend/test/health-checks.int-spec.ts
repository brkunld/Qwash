import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/http/configure-app';
import { HealthChecksController } from '../src/health/health-checks.controller';
import { MqttService } from '../src/iot/mqtt.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { testPrisma } from './db';

describe('Bagimlilik saglik uclari (gercek PostgreSQL)', () => {
  const prisma = testPrisma();
  const mqtt = { isConnected: true };
  let brokenDb = false;
  let app: INestApplication;

  beforeAll(async () => {
    const dbProxy = new Proxy(prisma, {
      get: (target, prop, receiver) =>
        prop === '$queryRaw' && brokenDb
          ? () => Promise.reject(new Error('veritabani yok'))
          : Reflect.get(target, prop, receiver),
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthChecksController],
      providers: [
        { provide: PrismaService, useValue: dbProxy },
        { provide: MqttService, useValue: mqtt },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, []);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(() => {
    mqtt.isConnected = true;
    brokenDb = false;
  });

  const get = (path: string) => request(app.getHttpServer()).get(`/api/v1/health/${path}`);

  it('her sey saglikliyken 200', async () => {
    expect((await get('db').expect(200)).body.data).toEqual({ db: 'ok' });
    expect((await get('mqtt').expect(200)).body.data).toEqual({ mqtt: 'ok' });
    expect((await get('ready').expect(200)).body.data).toEqual({
      status: 'ok',
      db: 'ok',
      mqtt: 'ok',
    });
  });

  it('MQTT kopukken /mqtt ve /ready 503, /db 200; ayrinti sizmaz', async () => {
    mqtt.isConnected = false;
    await get('db').expect(200);
    await get('mqtt').expect(503);
    const res = await get('ready').expect(503);
    expect(res.body.error.details).toEqual({ status: 'degraded', db: 'ok', mqtt: 'down' });
    expect(JSON.stringify(res.body)).not.toContain('Error');
  });

  it('veritabani yokken /db ve /ready 503', async () => {
    brokenDb = true;
    await get('db').expect(503);
    const res = await get('ready').expect(503);
    expect(res.body.error.details).toEqual({ status: 'degraded', db: 'down', mqtt: 'ok' });
    expect(JSON.stringify(res.body)).not.toContain('veritabani yok');
  });
});
