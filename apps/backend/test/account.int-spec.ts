import { ANONYMIZED_NAME, AccountService } from '../src/account/account.service';
import { hashPassword } from '../src/auth/auth.crypto';
import { InvalidCredentialsError, NameLockedError } from '../src/auth/auth.errors';
import { AuthService } from '../src/auth/auth.service';
import { CapturingMailer } from '../src/auth/mailer';
import { PrismaClient } from '../src/generated/prisma/client';
import {
  CardTopUpStatus,
  HoldStatus,
  LedgerSource,
  LedgerType,
  UserStatus,
} from '../src/generated/prisma/enums';
import { PaymentsService } from '../src/payments/payments.service';
import { WalletService } from '../src/wallet/wallet.service';
import { resetDatabase, testPrisma } from './db';
import { FakePaymentGateway } from './fake-payment-gateway';

const DAY = 24 * 60 * 60 * 1000;
const VALID_IBAN = 'TR330006100519786457841326';

describe('Hesap silme ve iade talebi (gercek PostgreSQL)', () => {
  let prisma: PrismaClient;
  let wallets: WalletService;
  let accounts: AccountService;
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
    clock = new Date('2026-09-26T12:00:00Z');
    accounts = new AccountService(prisma, wallets, { now: () => clock });
  });

  const daysAgo = (d: number) => new Date(clock.getTime() - d * DAY);

  async function customer(
    opts: { password?: string } = {},
  ): Promise<{ userId: string; walletId: string; email: string }> {
    seq += 1;
    const email = `sil${seq}@test.local`;
    const user = await prisma.user.create({
      data: {
        email,
        fullName: 'Ayse Yilmaz',
        emailVerifiedAt: new Date(),
        passwordHash: opts.password ? await hashPassword(opts.password) : null,
        wallet: { create: {} },
        identities: { create: { provider: 'GOOGLE', providerUserId: `g-${seq}` } },
      },
      include: { wallet: true },
    });
    return { userId: user.id, walletId: user.wallet!.id, email };
  }

  /** Iyzico'dan basariyla yuklenmis kart yuklemesi (odeme tarihi gun olarak). */
  async function cardTopUp(
    c: { userId: string; walletId: string },
    kurus: number,
    ageDays: number,
  ): Promise<string> {
    const topUp = await prisma.cardTopUp.create({
      data: {
        userId: c.userId,
        walletId: c.walletId,
        amountKurus: kurus,
        status: CardTopUpStatus.SUCCEEDED,
        idempotencyKey: `k-${Math.random()}`,
        iyzicoPaymentId: 'pay',
        paymentTransactionId: 'ptx',
        completedAt: daysAgo(ageDays),
      },
    });
    await wallets.credit({
      walletId: c.walletId,
      amountKurus: kurus,
      source: LedgerSource.CARD_TOPUP,
      idempotencyKey: `card-topup:${topUp.id}`,
      referenceId: topUp.id,
    });
    return topUp.id;
  }

  async function cashTopUp(walletId: string, kurus: number): Promise<void> {
    await wallets.credit({
      walletId,
      amountKurus: kurus,
      source: LedgerSource.CASH_TOPUP,
      idempotencyKey: `cash-${Math.random()}`,
    });
  }

  /** Yikama harcamasi: bloke + tahsil. */
  async function spend(walletId: string, kurus: number): Promise<void> {
    const { hold } = await wallets.hold({
      walletId,
      amountKurus: kurus,
      source: LedgerSource.SESSION,
      idempotencyKey: `s-${Math.random()}`,
    });
    await wallets.capture(hold.id, kurus);
  }

  describe('anonimlestirme', () => {
    it('bakiyesiz hesap: kisisel veri silinir, mali kayitlar kalir, ayni e-postayla yeni hesap acilabilir', async () => {
      const c = await customer({ password: 'gizli-sifre-1' });
      await cardTopUp(c, 5000, 10);
      await spend(c.walletId, 5000);
      await prisma.refreshToken.create({
        data: { userId: c.userId, tokenHash: 'h', expiresAt: new Date(Date.now() + DAY) },
      });

      await expect(
        accounts.deleteAccount(c.userId, { password: 'gizli-sifre-1' }),
      ).resolves.toEqual({
        refundRequestId: null,
        forfeitedKurus: 0,
      });

      const user = await prisma.user.findUniqueOrThrow({ where: { id: c.userId } });
      expect(user).toMatchObject({
        status: UserStatus.DELETED,
        email: `deleted_${c.userId}@anonymized.local`,
        fullName: ANONYMIZED_NAME,
        phoneNumber: null,
        passwordHash: null,
        emailVerifiedAt: null,
      });
      expect(await prisma.authIdentity.count({ where: { userId: c.userId } })).toBe(0);
      expect(await prisma.refreshToken.count({ where: { userId: c.userId } })).toBe(0);
      expect(await prisma.ledgerEntry.count({ where: { walletId: c.walletId } })).toBeGreaterThan(
        0,
      );
      expect(await prisma.cardTopUp.count({ where: { userId: c.userId } })).toBe(1);

      const auth = new AuthService(prisma, {
        accessSecret: 'a'.repeat(40),
        customerAppUrl: 'http://app.test',
        mailer: new CapturingMailer(),
        google: null,
      });
      await expect(
        auth.register({ email: c.email, password: 'yeni-sifre-1', fullName: 'Yeni' }),
      ).resolves.toBeDefined();
    });

    it('sifreli hesapta sifre zorunlu ve dogru olmali; Google hesabinda gerekmez', async () => {
      const withPassword = await customer({ password: 'gizli-sifre-1' });
      await expect(accounts.deleteAccount(withPassword.userId, {})).rejects.toMatchObject({
        code: 'PASSWORD_REQUIRED',
      });
      await expect(
        accounts.deleteAccount(withPassword.userId, { password: 'yanlis' }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);

      const google = await customer();
      await expect(accounts.deleteAccount(google.userId, {})).resolves.toBeDefined();
    });

    it('silinmis hesap ikinci kez silinemez', async () => {
      const c = await customer();
      await accounts.deleteAccount(c.userId, {});
      await expect(accounts.deleteAccount(c.userId, {})).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    });

    it('ayni anda iki silme isteginden yalniz biri gecer, feragat bir kez yazilir', async () => {
      const c = await customer();
      await cardTopUp(c, 3000, 5);
      const results = await Promise.allSettled([
        accounts.deleteAccount(c.userId, { balanceChoice: 'FORFEIT', confirmForfeit: true }),
        accounts.deleteAccount(c.userId, { balanceChoice: 'FORFEIT', confirmForfeit: true }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        await prisma.ledgerEntry.count({
          where: { walletId: c.walletId, source: LedgerSource.FORFEIT },
        }),
      ).toBe(1);
    });
  });

  describe('bakiye secenekleri', () => {
    it('bakiye varken secim yapilmazsa silinmez', async () => {
      const c = await customer();
      await cardTopUp(c, 3000, 5);
      await expect(accounts.deleteAccount(c.userId, {})).rejects.toMatchObject({
        code: 'BALANCE_DECISION_REQUIRED',
      });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: c.userId } })).status).toBe(
        UserStatus.ACTIVE,
      );
    });

    it('feragat onaysiz yapilmaz; onayla bakiye FORFEIT kaydiyla sifirlanir', async () => {
      const c = await customer();
      await cardTopUp(c, 4000, 5);
      await expect(
        accounts.deleteAccount(c.userId, { balanceChoice: 'FORFEIT' }),
      ).rejects.toMatchObject({
        code: 'FORFEIT_CONFIRMATION_REQUIRED',
      });

      await expect(
        accounts.deleteAccount(c.userId, { balanceChoice: 'FORFEIT', confirmForfeit: true }),
      ).resolves.toEqual({ refundRequestId: null, forfeitedKurus: 4000 });
      expect((await wallets.getBalance(c.walletId)).balanceKurus).toBe(0);
      const forfeit = await prisma.ledgerEntry.findFirstOrThrow({
        where: { walletId: c.walletId, source: LedgerSource.FORFEIT },
      });
      expect(forfeit).toMatchObject({
        type: LedgerType.DEBIT,
        amountKurus: 4000n,
        balanceAfterKurus: 0n,
      });
    });

    it("Burak'in ornegi: FIFO ile kalan 250 TL yeni yuklemeden karta iade talebi olur", async () => {
      const c = await customer();
      await cardTopUp(c, 20000, 400);
      const newer = await cardTopUp(c, 30000, 60);
      await spend(c.walletId, 25000);

      const preview = await accounts.previewDeletion(c.userId);
      expect(preview).toMatchObject({ availableKurus: 25000, ibanRequired: false, blockers: [] });

      const { refundRequestId } = await accounts.deleteAccount(c.userId, {
        balanceChoice: 'REFUND',
      });
      const request = await prisma.refundRequest.findUniqueOrThrow({
        where: { id: refundRequestId! },
      });
      expect(request).toMatchObject({
        status: 'REQUESTED',
        reason: 'ACCOUNT_DELETION',
        amountKurus: 25000,
        holderName: 'Ayse Yilmaz',
        contactEmail: expect.stringMatching(/^sil\d+@test\.local$/) as string,
        iban: null,
      });
      expect(request.allocation).toEqual([
        expect.objectContaining({ method: 'CARD', amountKurus: 25000, cardTopUpId: newer }),
      ]);

      // Tutar blokede: harcanamaz, ledger'da iz var, kullanici anonim.
      const hold = await prisma.walletHold.findUniqueOrThrow({ where: { id: request.holdId } });
      expect(hold).toMatchObject({
        status: HoldStatus.ACTIVE,
        amountKurus: 25000n,
        source: LedgerSource.REFUND,
      });
      expect((await wallets.getBalance(c.walletId)).availableKurus).toBe(0);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: c.userId } })).fullName).toBe(
        ANONYMIZED_NAME,
      );
    });

    it('365 gunu asan kart kismi IBAN ister; IBAN verilince talep olusur', async () => {
      const c = await customer();
      await cardTopUp(c, 50000, 400);

      expect(await accounts.previewDeletion(c.userId)).toMatchObject({ ibanRequired: true });
      await expect(
        accounts.deleteAccount(c.userId, { balanceChoice: 'REFUND' }),
      ).rejects.toMatchObject({
        code: 'IBAN_REQUIRED',
      });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: c.userId } })).status).toBe(
        UserStatus.ACTIVE,
      );

      const { refundRequestId } = await accounts.deleteAccount(c.userId, {
        balanceChoice: 'REFUND',
        iban: VALID_IBAN,
      });
      const request = await prisma.refundRequest.findUniqueOrThrow({
        where: { id: refundRequestId! },
      });
      expect(request.iban).toBe(VALID_IBAN);
      expect(request.allocation).toEqual([
        expect.objectContaining({ method: 'IBAN', amountKurus: 50000 }),
      ]);
    });

    it('nakit kismi IBAN yoksa istasyonda kasadan iade olarak isaretlenir', async () => {
      const c = await customer();
      await cardTopUp(c, 10000, 30);
      await cashTopUp(c.walletId, 6000);

      const { refundRequestId } = await accounts.deleteAccount(c.userId, {
        balanceChoice: 'REFUND',
      });
      const request = await prisma.refundRequest.findUniqueOrThrow({
        where: { id: refundRequestId! },
      });
      expect(request.allocation).toEqual([
        expect.objectContaining({
          method: 'CASH_AT_STATION',
          source: 'CASH_TOPUP',
          amountKurus: 6000,
        }),
        expect.objectContaining({ method: 'CARD', amountKurus: 10000 }),
      ]);
    });
  });

  describe('engeller', () => {
    it('devam eden seans (aktif bloke) varken silinemez', async () => {
      const c = await customer();
      await cardTopUp(c, 10000, 5);
      await wallets.hold({
        walletId: c.walletId,
        amountKurus: 3000,
        source: LedgerSource.SESSION,
        idempotencyKey: 'aktif',
      });
      expect(await accounts.previewDeletion(c.userId)).toMatchObject({ blockers: ['ACTIVE_HOLD'] });
      await expect(
        accounts.deleteAccount(c.userId, { balanceChoice: 'FORFEIT', confirmForfeit: true }),
      ).rejects.toMatchObject({
        code: 'ACTIVE_HOLD',
      });
    });

    it('sonuclanmamis veya gec basari gelebilecek kart yuklemesi varken silinemez', async () => {
      const c = await customer();
      await prisma.cardTopUp.create({
        data: {
          userId: c.userId,
          walletId: c.walletId,
          amountKurus: 5000,
          idempotencyKey: 'bekleyen',
          status: CardTopUpStatus.EXPIRED,
          createdAt: daysAgo(0.5),
        },
      });
      await expect(accounts.deleteAccount(c.userId, {})).rejects.toMatchObject({
        code: 'TOPUP_IN_PROGRESS',
      });

      clock = new Date(clock.getTime() + 2 * DAY);
      await expect(accounts.deleteAccount(c.userId, {})).resolves.toBeDefined();
    });
  });

  describe('ad muhru', () => {
    it('ilk basarili kart yuklemesi adi muhurler; sonra profilden degismez', async () => {
      const c = await customer();
      const auth = new AuthService(prisma, {
        accessSecret: 'a'.repeat(40),
        customerAppUrl: 'http://app.test',
        mailer: new CapturingMailer(),
        google: null,
      });
      await expect(auth.updateProfile(c.userId, { fullName: 'Ayse Kaya' })).resolves.toMatchObject({
        nameLocked: false,
      });

      const gateway = new FakePaymentGateway();
      const payments = new PaymentsService(prisma, wallets, {
        gateway,
        apiPublicUrl: 'http://api.test',
      });
      const { topUpId } = await payments.startTopUp({
        userId: c.userId,
        amountKurus: 10000,
        idempotencyKey: 'x',
        ip: null,
      });
      await payments.completeByToken(gateway.succeed(topUpId, 10000));

      await expect(auth.getMe(c.userId)).resolves.toMatchObject({
        nameLocked: true,
        fullName: 'Ayse Kaya',
      });
      await expect(auth.updateProfile(c.userId, { fullName: 'Baskasi' })).rejects.toBeInstanceOf(
        NameLockedError,
      );
      expect((await prisma.user.findUniqueOrThrow({ where: { id: c.userId } })).fullName).toBe(
        'Ayse Kaya',
      );
    });

    it('adi olmayan musteri kart yuklemesi baslatamaz', async () => {
      const c = await customer();
      await prisma.user.update({ where: { id: c.userId }, data: { fullName: null } });
      const payments = new PaymentsService(prisma, wallets, {
        gateway: new FakePaymentGateway(),
        apiPublicUrl: 'http://api.test',
      });
      await expect(
        payments.startTopUp({
          userId: c.userId,
          amountKurus: 10000,
          idempotencyKey: 'x',
          ip: null,
        }),
      ).rejects.toMatchObject({ code: 'FULL_NAME_REQUIRED' });
    });
  });
});
