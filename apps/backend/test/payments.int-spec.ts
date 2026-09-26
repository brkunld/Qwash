import { PrismaClient } from '../src/generated/prisma/client';
import { CardTopUpStatus, LedgerSource } from '../src/generated/prisma/enums';
import { PaymentProviderError } from '../src/payments/payment-gateway';
import {
  EmailNotVerifiedError,
  PaymentProviderUnavailableError,
  PaymentsDisabledError,
  TopUpAmountOutOfRangeError,
  TopUpIdempotencyConflictError,
} from '../src/payments/payments.errors';
import {
  EXPIRE_AFTER_MS,
  PaymentsService,
  RECONCILE_AFTER_MS,
} from '../src/payments/payments.service';
import { WalletService } from '../src/wallet/wallet.service';
import { resetDatabase, testPrisma } from './db';
import { FakePaymentGateway } from './fake-payment-gateway';

describe('PaymentsService kart yukleme (gercek PostgreSQL)', () => {
  let prisma: PrismaClient;
  let wallets: WalletService;
  let gateway: FakePaymentGateway;
  let payments: PaymentsService;
  let clock: Date;
  let seq = 0;

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
    clock = new Date();
    payments = new PaymentsService(prisma, wallets, {
      gateway,
      apiPublicUrl: 'http://api.test',
      now: () => clock,
    });
  });

  async function customer(verified = true): Promise<{ userId: string; walletId: string }> {
    seq += 1;
    const user = await prisma.user.create({
      data: {
        email: `m${seq}@test.local`,
        fullName: 'Ayse Yilmaz',
        emailVerifiedAt: verified ? new Date() : null,
        wallet: { create: {} },
      },
      include: { wallet: true },
    });
    return { userId: user.id, walletId: user.wallet!.id };
  }

  const start = (userId: string, amountKurus = 10000, key = 'k1') =>
    payments.startTopUp({ userId, amountKurus, idempotencyKey: key, ip: '10.0.0.1' });

  async function balance(walletId: string): Promise<number> {
    return (await wallets.getBalance(walletId)).balanceKurus;
  }

  async function cardCredits(walletId: string): Promise<number> {
    return prisma.ledgerEntry.count({ where: { walletId, source: LedgerSource.CARD_TOPUP } });
  }

  /** Kaydin olusturulma zamanini geriye alir (mutabakat senaryolari). */
  async function age(topUpId: string, ms: number): Promise<void> {
    await prisma.cardTopUp.update({
      where: { id: topUpId },
      data: { createdAt: new Date(clock.getTime() - ms) },
    });
  }

  describe('yukleme secenekleri', () => {
    it('hazir tutarlar admin minimumunun katlaridir', async () => {
      await expect(payments.getTopUpOptions()).resolves.toEqual({
        minKurus: 5000,
        maxKurus: 500000,
        presetsKurus: [5000, 10000, 20000],
      });
      await prisma.topUpSettings.update({ where: { id: 1 }, data: { minTopUpKurus: 7500 } });
      await expect(payments.getTopUpOptions()).resolves.toMatchObject({
        presetsKurus: [7500, 15000, 30000],
      });
    });

    it('maksimumu asan hazir tutar gosterilmez', async () => {
      await prisma.topUpSettings.upsert({
        where: { id: 1 },
        create: { id: 1, minTopUpKurus: 20000, maxTopUpKurus: 50000 },
        update: { minTopUpKurus: 20000, maxTopUpKurus: 50000 },
      });
      await expect(payments.getTopUpOptions()).resolves.toMatchObject({
        presetsKurus: [20000, 40000],
      });
    });
  });

  describe('yukleme baslatma', () => {
    it('odeme formunu acar; kayit PENDING, callback API adresine gider', async () => {
      const { userId } = await customer();
      const view = await start(userId, 10000);
      expect(view).toMatchObject({
        status: 'PENDING',
        amountKurus: 10000,
        paymentPageUrl: `https://pay.test/tok-${view.topUpId}`,
      });
      expect(gateway.initialized[0]).toMatchObject({
        topUpId: view.topUpId,
        amountKurus: 10000,
        callbackUrl: 'http://api.test/api/v1/payments/iyzico/callback',
        buyer: { fullName: 'Ayse Yilmaz', ip: '10.0.0.1' },
      });
    });

    it('e-postasi dogrulanmamis musteri yukleme yapamaz', async () => {
      const { userId } = await customer(false);
      await expect(start(userId)).rejects.toBeInstanceOf(EmailNotVerifiedError);
    });

    it('tutar admin araliginin disindaysa reddedilir', async () => {
      const { userId } = await customer();
      await expect(start(userId, 4999)).rejects.toBeInstanceOf(TopUpAmountOutOfRangeError);
      await expect(start(userId, 500001)).rejects.toBeInstanceOf(TopUpAmountOutOfRangeError);
      await expect(start(userId, 5000.5)).rejects.toBeInstanceOf(TopUpAmountOutOfRangeError);
    });

    it('Iyzico tanimli degilse anlasilir hata doner', async () => {
      const { userId } = await customer();
      const disabled = new PaymentsService(prisma, wallets, {
        gateway: null,
        apiPublicUrl: 'http://api.test',
      });
      await expect(
        disabled.startTopUp({ userId, amountKurus: 10000, idempotencyKey: 'k', ip: null }),
      ).rejects.toBeInstanceOf(PaymentsDisabledError);
    });

    it('ayni Idempotency-Key ayni yuklemeyi dondurur; farkli tutarla catisma verir', async () => {
      const { userId } = await customer();
      const first = await start(userId, 10000, 'tekrar');
      const again = await start(userId, 10000, 'tekrar');
      expect(again.topUpId).toBe(first.topUpId);
      expect(again.paymentPageUrl).toBe(first.paymentPageUrl);
      expect(gateway.initialized).toHaveLength(1);
      await expect(start(userId, 20000, 'tekrar')).rejects.toBeInstanceOf(
        TopUpIdempotencyConflictError,
      );
    });

    it('ayni anahtarla eszamanli iki istek tek yukleme olusturur', async () => {
      const { userId } = await customer();
      const [a, b] = await Promise.all([
        start(userId, 10000, 'yaris'),
        start(userId, 10000, 'yaris'),
      ]);
      expect(a.topUpId).toBe(b.topUpId);
      expect(await prisma.cardTopUp.count()).toBe(1);
    });

    it('Iyzico formu acamazsa yukleme FAILED olur ve 502 karsiligi hata doner', async () => {
      const { userId } = await customer();
      gateway.failInitialize = true;
      await expect(start(userId)).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
      const row = await prisma.cardTopUp.findFirstOrThrow();
      expect(row.status).toBe(CardTopUpStatus.FAILED);
    });
  });

  describe('sonuclanma', () => {
    it('basarili odeme bakiyeyi bir kez yukler ve iade icin Iyzico kimliklerini saklar', async () => {
      const { userId, walletId } = await customer();
      const { topUpId } = await start(userId, 10000);
      const token = gateway.succeed(topUpId, 10000);

      const done = await payments.completeByToken(token);
      expect(done).toMatchObject({
        status: CardTopUpStatus.SUCCEEDED,
        iyzicoPaymentId: `pay-${topUpId}`,
        paymentTransactionId: `ptx-${topUpId}`,
      });
      expect(await balance(walletId)).toBe(10000);

      await payments.completeByToken(token);
      expect(await balance(walletId)).toBe(10000);
      expect(await cardCredits(walletId)).toBe(1);
    });

    it('callback, webhook ve mutabakat ayni anda gelse de tek CREDIT olusur', async () => {
      const { userId, walletId } = await customer();
      const { topUpId } = await start(userId, 10000);
      const token = gateway.succeed(topUpId, 10000);

      await Promise.all([
        payments.completeByToken(token),
        payments.completeByToken(token),
        payments.completeByToken(token),
        payments.completeByToken(token),
      ]);
      expect(await balance(walletId)).toBe(10000);
      expect(await cardCredits(walletId)).toBe(1);
    });

    it('basarisiz odeme bakiye yuklemez; sonradan gelen tekrar durumu degistirmez', async () => {
      const { userId, walletId } = await customer();
      const { topUpId } = await start(userId);
      const token = `tok-${topUpId}`;
      gateway.outcomes.set(token, { kind: 'FAILURE', reason: 'Kart reddedildi' });

      await expect(payments.completeByToken(token)).resolves.toMatchObject({
        status: CardTopUpStatus.FAILED,
        failureReason: 'Kart reddedildi',
      });
      gateway.succeed(topUpId, 10000);
      await expect(payments.completeByToken(token)).resolves.toMatchObject({
        status: CardTopUpStatus.FAILED,
      });
      expect(await balance(walletId)).toBe(0);
    });

    it('tutar veya sepet uyusmazsa bakiye yuklenmez, incelemeye duser', async () => {
      const { userId, walletId } = await customer();
      const { topUpId } = await start(userId, 10000);
      const token = gateway.succeed(topUpId, 100);

      const row = await payments.completeByToken(token);
      expect(row?.status).toBe(CardTopUpStatus.FAILED);
      expect(row?.failureReason).toMatch(/^INCELEME: tutar 100 != 10000/);
      expect(row?.iyzicoPaymentId).toBe(`pay-${topUpId}`);
      expect(await balance(walletId)).toBe(0);
      await expect(payments.getTopUp(userId, topUpId)).resolves.toMatchObject({
        failureReason: 'Odeme inceleniyor',
      });
    });

    it('conversationId gelmeyen basari yaniti basketId ile kabul edilir (gercek sandbox yaniti)', async () => {
      const { userId, walletId } = await customer();
      const { topUpId } = await start(userId, 10000);
      const token = gateway.succeed(topUpId, 10000, { conversationId: null });
      await expect(payments.completeByToken(token)).resolves.toMatchObject({
        status: CardTopUpStatus.SUCCEEDED,
      });
      expect(await balance(walletId)).toBe(10000);
    });

    it('baska yuklemenin sepetine ait basari kabul edilmez', async () => {
      const { userId, walletId } = await customer();
      const { topUpId } = await start(userId, 10000);
      const token = gateway.succeed(topUpId, 10000, { basketId: 'baska-yukleme' });
      await expect(payments.completeByToken(token)).resolves.toMatchObject({
        status: CardTopUpStatus.FAILED,
      });
      expect(await balance(walletId)).toBe(0);
    });

    it('Iyzico sorgusu hata verirse durum degismez, hata yukari tasinir', async () => {
      const { userId } = await customer();
      const { topUpId } = await start(userId);
      gateway.outcomes.set(`tok-${topUpId}`, new PaymentProviderError('imza dogrulanamadi'));
      await expect(payments.completeByToken(`tok-${topUpId}`)).rejects.toBeInstanceOf(
        PaymentProviderError,
      );
      await expect(payments.getTopUp(userId, topUpId)).resolves.toMatchObject({
        status: 'PENDING',
      });
    });

    it('bilinmeyen token icin null doner', async () => {
      await expect(payments.completeByToken('tok-yok')).resolves.toBeNull();
    });
  });

  describe('mutabakat', () => {
    it('callback kaybolsa da odeme mutabakatla tamamlanir', async () => {
      const { userId, walletId } = await customer();
      const { topUpId } = await start(userId, 10000);
      gateway.succeed(topUpId, 10000);

      // Cok yeni kayit henuz sorulmaz
      await expect(payments.reconcile()).resolves.toMatchObject({ checked: 0 });
      await age(topUpId, RECONCILE_AFTER_MS + 1000);
      await expect(payments.reconcile()).resolves.toMatchObject({ checked: 1 });
      expect(await balance(walletId)).toBe(10000);
    });

    it('sonucu gelmeyen yukleme EXPIRED olur; gec gelen basari yine yuklenir', async () => {
      const { userId, walletId } = await customer();
      const { topUpId } = await start(userId, 10000);
      await age(topUpId, EXPIRE_AFTER_MS + 1000);

      await expect(payments.reconcile()).resolves.toMatchObject({ expired: 1 });
      await expect(payments.getTopUp(userId, topUpId)).resolves.toMatchObject({
        status: 'EXPIRED',
        paymentPageUrl: null,
      });

      gateway.succeed(topUpId, 10000);
      await payments.reconcile();
      await expect(payments.getTopUp(userId, topUpId)).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
      expect(await balance(walletId)).toBe(10000);
    });

    it('formu hic acilamamis kayit FAILED olur', async () => {
      const { userId, walletId } = await customer();
      await prisma.cardTopUp.create({
        data: {
          userId,
          walletId,
          amountKurus: 10000,
          idempotencyKey: 'yarim',
          createdAt: new Date(clock.getTime() - 11 * 60 * 1000),
        },
      });
      await expect(payments.reconcile()).resolves.toMatchObject({ abandoned: 1 });
    });

    it('Iyzico sorgusu hata verse de tur devam eder', async () => {
      const { userId, walletId } = await customer();
      const a = await start(userId, 10000, 'a');
      const b = await start(userId, 20000, 'b');
      gateway.outcomes.set(`tok-${a.topUpId}`, new PaymentProviderError('ag hatasi'));
      gateway.succeed(b.topUpId, 20000);
      await age(a.topUpId, RECONCILE_AFTER_MS + 2000);
      await age(b.topUpId, RECONCILE_AFTER_MS + 1000);

      await payments.reconcile();
      expect(await balance(walletId)).toBe(20000);
    });
  });

  it('musteri baskasinin yuklemesini goremez', async () => {
    const a = await customer();
    const b = await customer();
    const { topUpId } = await start(a.userId);
    await expect(payments.getTopUp(b.userId, topUpId)).rejects.toMatchObject({
      code: 'TOPUP_NOT_FOUND',
    });
  });
});
