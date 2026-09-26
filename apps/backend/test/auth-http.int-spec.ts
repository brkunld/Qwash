import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { AuthController, COOKIE_SECURE, REFRESH_COOKIE } from '../src/auth/auth.controller';
import { AccessTokenGuard } from '../src/auth/auth.guard';
import { AuthService } from '../src/auth/auth.service';
import { CapturingMailer } from '../src/auth/mailer';
import { PrismaClient } from '../src/generated/prisma/client';
import { configureApp } from '../src/http/configure-app';
import { resetDatabase, testPrisma } from './db';

describe('Auth HTTP (gercek PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let mailer: CapturingMailer;

  beforeAll(() => {
    prisma = testPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    mailer = new CapturingMailer();
    const auth = new AuthService(prisma, {
      accessSecret: 'http-test-secret-at-least-32-characters',
      customerAppUrl: 'http://app.test',
      mailer,
      google: null,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: COOKIE_SECURE, useValue: true },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        AccessTokenGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, ['http://app.test']);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  function refreshCookie(res: request.Response): string {
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const cookie = cookies.find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
    if (!cookie) throw new Error('refresh cookie yok');
    return cookie;
  }

  it('kayit: zarfli yanit, refresh token yalniz guvenli cookie de', async () => {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({ email: ' Ali@Test.Local ', password: 'gizli-sifre-1', fullName: 'Ali Veli' })
      .expect(201);

    expect(res.body).toMatchObject({
      success: true,
      data: { user: { email: 'ali@test.local', emailVerified: false } },
      metadata: { timestamp: expect.any(String) as string },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/refreshToken/);
    const cookie = refreshCookie(res);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
  });

  it('/me token ister; access token ile profil doner', async () => {
    await http().get('/api/v1/me').expect(401);
    const reg = await http()
      .post('/api/v1/auth/register')
      .send({ email: 'ali@test.local', password: 'gizli-sifre-1', fullName: 'Ali Veli' });
    const token = (reg.body as { data: { accessToken: string } }).data.accessToken;

    const me = await http().get('/api/v1/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(me.body).toMatchObject({
      success: true,
      data: { email: 'ali@test.local', hasPassword: true },
    });

    const unauth = await http().get('/api/v1/me').set('Authorization', 'Bearer bozuk').expect(401);
    expect(unauth.body).toMatchObject({ success: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('refresh cookie ile yeni oturum; cikis sonrasi cookie gecersiz', async () => {
    const reg = await http()
      .post('/api/v1/auth/register')
      .send({ email: 'ali@test.local', password: 'gizli-sifre-1', fullName: 'Ali Veli' });
    const first = refreshCookie(reg).split(';')[0]!;

    const refreshed = await http().post('/api/v1/auth/refresh').set('Cookie', first).expect(200);
    const second = refreshCookie(refreshed).split(';')[0]!;
    expect(second).not.toBe(first);

    await http().post('/api/v1/auth/logout').set('Cookie', second).expect(204);
    await http().post('/api/v1/auth/refresh').set('Cookie', second).expect(401);
    await http().post('/api/v1/auth/refresh').expect(401);
  });

  it('gecersiz istek anlasilir dogrulama hatasi doner', async () => {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({ email: 'gecersiz', password: 'kisa', fullName: 'A' })
      .expect(400);
    expect(res.body).toMatchObject({ success: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('sifre sifirlama hesap olmasa da 204 doner', async () => {
    await http().post('/api/v1/auth/forgot-password').send({ email: 'yok@test.local' }).expect(204);
  });

  it('giris denemeleri 15 dakikada 10 ile sinirli', async () => {
    for (let i = 0; i < 10; i += 1) {
      await http()
        .post('/api/v1/auth/login')
        .send({ email: 'yok@test.local', password: 'x' })
        .expect(401);
    }
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ email: 'yok@test.local', password: 'x' })
      .expect(429);
    expect(res.body).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
  });
});
