import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthResponseSchema } from '@qwash/contracts';
import request from 'supertest';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health ortak kontrata uyan cevap doner', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(HealthResponseSchema.safeParse(res.body).success).toBe(true);
  });
});
