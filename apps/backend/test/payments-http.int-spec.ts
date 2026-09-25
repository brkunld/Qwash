import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { AccessTokenGuard } from '../src/auth/auth.guard';
import { AuthService } from '../src/auth/auth.service';
import { CapturingMailer } from '../src/auth/mailer';
import { PrismaClient } from '../src/generated/prisma/client';
import { configureApp } from '../src/http/configure-app';
import { PaymentGateway } from '../src/payments/payment-gateway';
import { CUSTOMER_APP_URL, PaymentsController } from '../src/payments/payments.controller';
import { PaymentsService } from '../src/payments/payments.service';
import { WalletService } from '../src/wallet/wallet.service';
import { resetDatabase, testPrisma } from './db';
import { FakePaymentGateway } from './fake-payment-gateway';

describe('Payments HTTP (gercek PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let auth: AuthService;
  let gateway: FakePaymentGateway;
  let wallets: WalletService;

  beforeAll(() => {
    prisma = testPrisma();
    wallets = new WalletService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    gateway = new FakePaymentGateway();
    auth = new AuthService(prisma, {
      accessSecret: 'p'.repeat(40),
      customerAppUrl: 'http://app.test',
      mailer: new CapturingMailer(),
      google: null,
    });
    const payments = new PaymentsService(prisma, wallets, {
      gateway,
      apiPublicUrl: 'http://api.test',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
      controllers: [PaymentsController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: PaymentsService, useValue: payments },
        { provide: PaymentGateway, useValue: gateway },
        { provide: CUSTOMER_APP_URL, useValue: 'http://app.test' },
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

  async function verifiedCustomer(): Promise<{ token: string; walletId: string }> {
    const session = await auth.register({
      email: 'ali@test.local',
      password: 'gizli-sifre-1',
      fullName: 'Ali Veli',
    });
    await prisma.user.update({
      where: { id: session.user.id },
      data: { emailVerifiedAt: new Date() },
    });
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: session.user.id } });
    return { token: session.accessToken, walletId: wallet.id };
  }

  it('secenekler ve yukleme giris ister; Idempotency-Key zorunlu', async () => {
    await http().get('/api/v1/payments/topup-options').expect(401);
    const { token } = await verifiedCustomer();

    const options = await http()
      .get('/api/v1/payments/topup-options')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(options.body).toMatchObject({
      success: true,
      data: { presetsKurus: [5000, 10000, 20000] },
    });

    const noKey = await http()
      .post('/api/v1/payments/topup')
      .set('Authorization', `Bearer ${token}`)
      .send({ amountKurus: 10000 })
      .expect(400);
    expect(noKey.body).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });

    const low = await http()
      .post('/api/v1/payments/topup')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'k-low')
      .send({ amountKurus: 100 })
      .expect(400);
    expect(low.body).toMatchObject({
      error: { code: 'TOPUP_AMOUNT_OUT_OF_RANGE', details: { minKurus: 5000 } },
    });
  });

  it('uctan uca: yukleme -> Iyzico callback -> sonuc sayfasina yonlendirme -> bakiye', async () => {
    const { token, walletId } = await verifiedCustomer();
    const started = await http()
      .post('/api/v1/payments/topup')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'k-1')
      .send({ amountKurus: 10000 })
      .expect(201);
    const { topUpId, paymentPageUrl } = (
      started.body as { data: { topUpId: string; paymentPageUrl: string } }
    ).data;
    expect(paymentPageUrl).toBe(`https://pay.test/tok-${topUpId}`);

    gateway.succeed(topUpId, 10000);
    // Iyzico tarayiciyi form POST ile geri yollar
    const cb = await http()
      .post('/api/v1/payments/iyzico/callback')
      .type('form')
      .send({ token: `tok-${topUpId}` })
      .expect(303);
    expect(cb.headers.location).toBe(`http://app.test/wallet/topup-result?id=${topUpId}`);
    expect((await wallets.getBalance(walletId)).balanceKurus).toBe(10000);

    const status = await http()
      .get(`/api/v1/payments/topups/${topUpId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(status.body).toMatchObject({ data: { status: 'SUCCEEDED', paymentPageUrl: null } });
  });

  it('callback sonucu soramazsa yine sonuc sayfasina yonlendirir, durum bozulmaz', async () => {
    const cb = await http()
      .post('/api/v1/payments/iyzico/callback')
      .type('form')
      .send({ token: 'bilinmeyen' })
      .expect(303);
    expect(cb.headers.location).toBe('http://app.test/wallet/topup-result');
  });

  it('webhook imzasiz/yanlis imzali istegi reddeder, dogru imzada yuklemeyi tamamlar', async () => {
    const { token, walletId } = await verifiedCustomer();
    const started = await http()
      .post('/api/v1/payments/topup')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'k-wh')
      .send({ amountKurus: 20000 })
      .expect(201);
    const { topUpId } = (started.body as { data: { topUpId: string } }).data;
    gateway.succeed(topUpId, 20000);
    const body = {
      token: `tok-${topUpId}`,
      status: 'SUCCESS',
      iyziEventType: 'CHECKOUT_FORM_AUTH',
    };

    await http().post('/api/v1/payments/webhook').send(body).expect(403);
    await http()
      .post('/api/v1/payments/webhook')
      .set('X-IYZ-SIGNATURE-V3', 'yanlis')
      .send(body)
      .expect(403);
    expect((await wallets.getBalance(walletId)).balanceKurus).toBe(0);

    await http()
      .post('/api/v1/payments/webhook')
      .set('X-IYZ-SIGNATURE-V3', gateway.webhookSecret)
      .send(body)
      .expect(200);
    // Iyzico ayni bildirimi tekrar gonderir
    await http()
      .post('/api/v1/payments/webhook')
      .set('X-IYZ-SIGNATURE-V3', gateway.webhookSecret)
      .send(body)
      .expect(200);
    expect((await wallets.getBalance(walletId)).balanceKurus).toBe(20000);
  });
});
