import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { AccountService } from '../src/account/account.service';
import { AdminController } from '../src/admin/admin.controller';
import type { AdminActor } from '../src/admin/admin.guard';
import { AdminGuard } from '../src/admin/admin.guard';
import { AdminService } from '../src/admin/admin.service';
import { RefundAdminService } from '../src/admin/refund-admin.service';
import { AuthService } from '../src/auth/auth.service';
import { CapturingMailer } from '../src/auth/mailer';
import { PrismaClient } from '../src/generated/prisma/client';
import {
  CardTopUpStatus,
  HoldStatus,
  LedgerSource,
  LedgerType,
  UserRole,
  UserStatus,
} from '../src/generated/prisma/enums';
import { configureApp } from '../src/http/configure-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { WalletService } from '../src/wallet/wallet.service';
import { resetDatabase, testPrisma } from './db';
import { FakePaymentGateway } from './fake-payment-gateway';

const DAY = 24 * 60 * 60 * 1000;
const VALID_IBAN = 'TR330006100519786457841326';

describe('Admin operasyonlari (gercek PostgreSQL)', () => {
  let prisma: PrismaClient;
  let wallets: WalletService;
  let admin: AdminService;
  let refunds: RefundAdminService;
  let accounts: AccountService;
  let gateway: FakePaymentGateway;
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
    admin = new AdminService(prisma, wallets);
    refunds = new RefundAdminService(prisma, wallets, { gateway });
    accounts = new AccountService(prisma, wallets);
  });

  async function user(
    opts: { role?: UserRole; status?: UserStatus; fullName?: string } = {},
  ): Promise<{ userId: string; walletId: string; email: string }> {
    seq += 1;
    const email = `u${seq}@test.local`;
    const u = await prisma.user.create({
      data: {
        email,
        fullName: opts.fullName ?? 'Ayse Yilmaz',
        emailVerifiedAt: new Date(),
        role: opts.role ?? UserRole.USER,
        status: opts.status ?? UserStatus.ACTIVE,
        wallet: { create: {} },
      },
      include: { wallet: true },
    });
    return { userId: u.id, walletId: u.wallet!.id, email };
  }

  async function operator(role: UserRole = UserRole.ADMIN): Promise<AdminActor> {
    const u = await user({ role });
    return { userId: u.userId, role: role as 'ADMIN' | 'SUPER_ADMIN' };
  }

  async function station(code = 'STATION-01'): Promise<string> {
    const s = await prisma.station.create({ data: { code, name: code } });
    return s.id;
  }

  async function balance(walletId: string) {
    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
    return { balance: Number(w.balanceKurus), hold: Number(w.holdKurus) };
  }

  // -------------------------------------------------------------------------

  describe('nakit yukleme', () => {
    it('bakiye, makbuz ve denetim kaydi birlikte yazilir; makbuz numarasi artar', async () => {
      const op = await operator();
      const st = await station();
      const c = await user();

      const r1 = await admin.cashTopUp(
        op,
        { userId: c.userId, stationId: st, amountKurus: 10000 },
        'k1',
      );
      const r2 = await admin.cashTopUp(
        op,
        { userId: c.userId, stationId: st, amountKurus: 5000 },
        'k2',
      );

      expect(r1).toMatchObject({
        amountKurus: 10000,
        balanceAfterKurus: 10000,
        userEmail: c.email,
      });
      expect(r2.balanceAfterKurus).toBe(15000);
      expect(r2.receiptNo).toBeGreaterThan(r1.receiptNo);
      expect(await balance(c.walletId)).toEqual({ balance: 15000, hold: 0 });

      const ledger = await prisma.ledgerEntry.findMany({ where: { walletId: c.walletId } });
      expect(ledger).toHaveLength(2);
      expect(ledger.every((e) => e.source === LedgerSource.CASH_TOPUP)).toBe(true);
      const audits = await prisma.adminAuditLog.findMany({ where: { action: 'CASH_TOPUP' } });
      expect(audits).toHaveLength(2);
      expect(audits[0]).toMatchObject({ actorId: op.userId, targetId: c.userId });
    });

    it('ayni anahtar tekrari ve 10 paralel istek: tek para girisi, ayni makbuz', async () => {
      const op = await operator();
      const st = await station();
      const c = await user();
      const input = { userId: c.userId, stationId: st, amountKurus: 2000 };

      const results = await Promise.all(
        Array.from({ length: 10 }, () => admin.cashTopUp(op, input, 'ayni')),
      );
      const again = await admin.cashTopUp(op, input, 'ayni');

      expect(new Set([...results, again].map((r) => r.receiptNo)).size).toBe(1);
      expect(await balance(c.walletId)).toEqual({ balance: 2000, hold: 0 });
      expect(await prisma.cashTopUp.count()).toBe(1);
      expect(await prisma.adminAuditLog.count()).toBe(1);
    });

    it('ayni anahtar farkli tutarla gelirse reddedilir', async () => {
      const op = await operator();
      const st = await station();
      const c = await user();
      await admin.cashTopUp(op, { userId: c.userId, stationId: st, amountKurus: 2000 }, 'k');
      await expect(
        admin.cashTopUp(op, { userId: c.userId, stationId: st, amountKurus: 3000 }, 'k'),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });

    it('aktif olmayan hesaba ve ust siniri asan tutara yukleme yapilmaz', async () => {
      const op = await operator();
      const st = await station();
      const deleted = await user({ status: UserStatus.DELETED });
      await expect(
        admin.cashTopUp(op, { userId: deleted.userId, stationId: st, amountKurus: 1000 }, 'a'),
      ).rejects.toMatchObject({ code: 'TARGET_ACCOUNT_NOT_ACTIVE' });

      const c = await user();
      await expect(
        admin.cashTopUp(op, { userId: c.userId, stationId: st, amountKurus: 500001 }, 'b'),
      ).rejects.toMatchObject({ code: 'CASH_AMOUNT_OUT_OF_RANGE' });
      expect(await prisma.ledgerEntry.count()).toBe(0);
      expect(await prisma.adminAuditLog.count()).toBe(0);
    });
  });

  describe('kasa raporu', () => {
    it('Istanbul gunune gore operator bazinda giris ve kasadan iade toplar', async () => {
      const op1 = await operator();
      const op2 = await operator();
      const st = await station();
      const other = await station('STATION-02');
      const c = await user();

      const a = await admin.cashTopUp(
        op1,
        { userId: c.userId, stationId: st, amountKurus: 10000 },
        'a',
      );
      const b = await admin.cashTopUp(
        op2,
        { userId: c.userId, stationId: st, amountKurus: 3000 },
        'b',
      );
      const late = await admin.cashTopUp(
        op1,
        { userId: c.userId, stationId: st, amountKurus: 700 },
        'c',
      );
      const nextDay = await admin.cashTopUp(
        op1,
        { userId: c.userId, stationId: st, amountKurus: 900 },
        'd',
      );
      await admin.cashTopUp(op1, { userId: c.userId, stationId: other, amountKurus: 5000 }, 'e');

      // 26 Eylul Istanbul: 25 Eylul 21:00Z .. 26 Eylul 21:00Z
      await prisma.cashTopUp.update({
        where: { id: a.id },
        data: { createdAt: new Date('2026-09-26T06:00:00Z') },
      });
      await prisma.cashTopUp.update({
        where: { id: b.id },
        data: { createdAt: new Date('2026-09-26T12:00:00Z') },
      });
      await prisma.cashTopUp.update({
        where: { id: late.id },
        data: { createdAt: new Date('2026-09-26T20:59:00Z') },
      });
      await prisma.cashTopUp.update({
        where: { id: nextDay.id },
        data: { createdAt: new Date('2026-09-26T21:00:00Z') },
      });

      // Kasadan nakit iade (iade isleme akisindan bagimsiz, dogrudan satir).
      const req = await refundRequestFixture(c, 1200);
      await prisma.refundPayout.create({
        data: {
          refundRequestId: req,
          partIndex: 0,
          method: 'CASH_AT_STATION',
          amountKurus: 1200,
          status: 'DONE',
          stationId: st,
          operatorId: op2.userId,
          completedAt: new Date('2026-09-26T15:00:00Z'),
        },
      });

      const report = await admin.cashReport({ date: '2026-09-26', stationId: st });
      // Gun icinde: a (10000) + late (700) op1, b (3000) op2. Ertesi gun ve diger istasyon disarida.
      expect(report.totalTopUpKurus).toBe(13700);
      expect(report.totalCashRefundKurus).toBe(1200);
      expect(report.expectedCashKurus).toBe(12500);
      const byOp = Object.fromEntries(report.byOperator.map((o) => [o.operatorId, o]));
      expect(byOp[op1.userId]).toMatchObject({
        topUpCount: 2,
        topUpKurus: 10700,
        cashRefundCount: 0,
        cashRefundKurus: 0,
      });
      expect(byOp[op2.userId]).toMatchObject({
        topUpCount: 1,
        topUpKurus: 3000,
        cashRefundCount: 1,
        cashRefundKurus: 1200,
      });
    });
  });

  describe('manuel bakiye duzeltme', () => {
    it('CREDIT ve DEBIT gerekceyle denetime yazilir; tekrar ayni sonucu dondurur', async () => {
      const op = await operator();
      const c = await user();
      const reason = 'Seans 1234 cift tahsil edildi, fark iade';

      const up = await admin.adjustBalance(
        op,
        c.userId,
        { direction: 'CREDIT', amountKurus: 900, reason },
        'x1',
      );
      const again = await admin.adjustBalance(
        op,
        c.userId,
        { direction: 'CREDIT', amountKurus: 900, reason },
        'x1',
      );
      expect(again).toEqual(up);
      const down = await admin.adjustBalance(
        op,
        c.userId,
        { direction: 'DEBIT', amountKurus: 400, reason: 'Yanlis girilen duzeltme geri alindi' },
        'x2',
      );
      expect(down.balanceAfterKurus).toBe(500);

      const entries = await prisma.ledgerEntry.findMany({
        where: { walletId: c.walletId },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries.map((e) => [e.type, e.source, Number(e.amountKurus)])).toEqual([
        [LedgerType.CREDIT, LedgerSource.ADJUSTMENT, 900],
        [LedgerType.DEBIT, LedgerSource.ADJUSTMENT, 400],
      ]);
      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: 'BALANCE_ADJUSTMENT', reason },
      });
      expect(audit.actorId).toBe(op.userId);
    });

    it('DEBIT bloke edilmis tutara dokunmaz', async () => {
      const op = await operator();
      const c = await user();
      await wallets.credit({
        walletId: c.walletId,
        amountKurus: 1000,
        source: LedgerSource.CASH_TOPUP,
        idempotencyKey: 'c',
      });
      await wallets.hold({
        walletId: c.walletId,
        amountKurus: 800,
        source: LedgerSource.SESSION,
        idempotencyKey: 'h',
      });
      await expect(
        admin.adjustBalance(
          op,
          c.userId,
          { direction: 'DEBIT', amountKurus: 300, reason: 'Hatali yukleme geri aliniyor' },
          'd',
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_AVAILABLE', details: { availableKurus: 200 } });
      expect(await balance(c.walletId)).toEqual({ balance: 1000, hold: 800 });
      expect(await prisma.adminAuditLog.count()).toBe(0);
    });
  });

  it('denetim kaydi degistirilemez ve silinemez', async () => {
    const op = await operator();
    const st = await station();
    const c = await user();
    await admin.cashTopUp(op, { userId: c.userId, stationId: st, amountKurus: 100 }, 'k');
    const row = await prisma.adminAuditLog.findFirstOrThrow();
    await expect(
      prisma.adminAuditLog.update({ where: { id: row.id }, data: { reason: 'degisti' } }),
    ).rejects.toThrow(/degistirilemez/);
    await expect(prisma.adminAuditLog.delete({ where: { id: row.id } })).rejects.toThrow(
      /degistirilemez/,
    );
  });

  // -------------------------------------------------------------------------

  describe('iade talebi isleme', () => {
    /** Kart yuklemesi (odeme tarihi gun olarak) + CREDIT. */
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
          paymentTransactionId: `ptx-${Math.random()}`,
          completedAt: new Date(Date.now() - ageDays * DAY),
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

    /** Kart (yeni) + nakit, IBAN yok: parcalar CARD + CASH_AT_STATION. */
    async function cardAndCashRequest() {
      const c = await user();
      const cardId = await cardTopUp(c, 6000, 10);
      await wallets.credit({
        walletId: c.walletId,
        amountKurus: 2500,
        source: LedgerSource.CASH_TOPUP,
        idempotencyKey: `cash-${Math.random()}`,
      });
      const { refundRequestId } = await accounts.deleteAccount(c.userId, {
        balanceChoice: 'REFUND',
      });
      return { c, cardId, requestId: refundRequestId! };
    }

    it('parcalar dagilimdan olusur; kart Iyzico ile, nakit kasadan odenince talep kapanir', async () => {
      const op = await operator();
      const st = await station();
      const { c, cardId, requestId } = await cardAndCashRequest();
      expect(await balance(c.walletId)).toEqual({ balance: 8500, hold: 8500 });

      const view = await refunds.get(requestId);
      expect(view.payouts.map((p) => [p.method, p.amountKurus, p.status])).toEqual(
        expect.arrayContaining([
          ['CARD', 6000, 'PENDING'],
          ['CASH_AT_STATION', 2500, 'PENDING'],
        ]),
      );
      const card = view.payouts.find((p) => p.method === 'CARD')!;
      const cash = view.payouts.find((p) => p.method === 'CASH_AT_STATION')!;

      const afterCard = await refunds.sendCardPayout(op, requestId, card.partIndex);
      expect(gateway.refunds).toHaveLength(1);
      expect(gateway.refunds[0]).toMatchObject({ amountKurus: 6000 });
      expect(afterCard.status).toBe('REQUESTED');
      expect(afterCard.payouts.find((p) => p.method === 'CARD')!.status).toBe('DONE');
      expect(
        (await prisma.cardTopUp.findUniqueOrThrow({ where: { id: cardId } })).refundedKurus,
      ).toBe(6000);

      await expect(
        refunds.resolvePayout(op, requestId, cash.partIndex, {
          outcome: 'PAID',
          reference: 'kasa fis 12',
        }),
      ).rejects.toMatchObject({ code: 'STATION_REQUIRED' });

      const done = await refunds.resolvePayout(op, requestId, cash.partIndex, {
        outcome: 'PAID',
        reference: 'kasa fis 12',
        stationId: st,
      });
      expect(done.status).toBe('COMPLETED');
      expect(done.contactEmail).toBeNull();
      expect(await balance(c.walletId)).toEqual({ balance: 0, hold: 0 });

      const hold = await prisma.walletHold.findFirstOrThrow({
        where: { source: LedgerSource.REFUND },
      });
      expect(hold).toMatchObject({ status: HoldStatus.CAPTURED, capturedKurus: 8500n });
      expect(
        await prisma.adminAuditLog.count({
          where: { action: 'REFUND_COMPLETED', targetId: requestId },
        }),
      ).toBe(1);

      // Kapanmis talepte islem yapilamaz.
      await expect(refunds.sendCardPayout(op, requestId, card.partIndex)).rejects.toMatchObject({
        code: 'REFUND_REQUEST_CLOSED',
      });
    });

    it('Iyzico cevabi belirsizse parca IN_FLIGHT kalir, tekrar gonderilemez; admin sonuclandirir', async () => {
      const op = await operator();
      const { requestId } = await cardAndCashRequest();
      const card = (await refunds.get(requestId)).payouts.find((p) => p.method === 'CARD')!;

      gateway.refundMode = 'TIMEOUT';
      const v1 = await refunds.sendCardPayout(op, requestId, card.partIndex);
      expect(v1.payouts.find((p) => p.method === 'CARD')!.status).toBe('IN_FLIGHT');

      gateway.refundMode = 'OK';
      await expect(refunds.sendCardPayout(op, requestId, card.partIndex)).rejects.toMatchObject({
        code: 'PAYOUT_STATE',
      });
      expect(gateway.refunds).toHaveLength(1);

      // Admin Iyzico panelinde iadenin OLMADIGINI gordu: yeniden denenebilir hale gelir.
      const v2 = await refunds.resolvePayout(op, requestId, card.partIndex, {
        outcome: 'NOT_PAID',
        reason: 'Iyzico panelinde iade kaydi yok',
      });
      expect(v2.payouts.find((p) => p.method === 'CARD')!.status).toBe('FAILED');
      const v3 = await refunds.sendCardPayout(op, requestId, card.partIndex);
      expect(v3.payouts.find((p) => p.method === 'CARD')!.status).toBe('DONE');
      expect(gateway.refunds).toHaveLength(2);
    });

    it('IN_FLIGHT kart parcasi Iyzico panelinde goruldu: "odendi" ile kapanir, ikinci iade yok', async () => {
      const op = await operator();
      const { cardId, requestId } = await cardAndCashRequest();
      const card = (await refunds.get(requestId)).payouts.find((p) => p.method === 'CARD')!;
      gateway.refundMode = 'TIMEOUT';
      await refunds.sendCardPayout(op, requestId, card.partIndex);

      const v = await refunds.resolvePayout(op, requestId, card.partIndex, {
        outcome: 'PAID',
        reference: 'iyzico-iade-778',
      });
      expect(v.payouts.find((p) => p.method === 'CARD')).toMatchObject({
        status: 'DONE',
        reference: 'iyzico-iade-778',
      });
      expect(
        (await prisma.cardTopUp.findUniqueOrThrow({ where: { id: cardId } })).refundedKurus,
      ).toBe(6000);
      expect(gateway.refunds).toHaveLength(1);
    });

    it('Iyzico reddederse parca FAILED olur ve yeniden denenebilir', async () => {
      const op = await operator();
      const { requestId } = await cardAndCashRequest();
      const card = (await refunds.get(requestId)).payouts.find((p) => p.method === 'CARD')!;
      gateway.refundMode = 'REJECT';
      const v = await refunds.sendCardPayout(op, requestId, card.partIndex);
      expect(v.payouts.find((p) => p.method === 'CARD')).toMatchObject({
        status: 'FAILED',
        failureReason: '10093 iade suresi gecmis',
      });
    });

    it('ayni kart parcasi icin eszamanli iki istek: Iyzico yalniz bir kez cagrilir', async () => {
      const op = await operator();
      const { requestId } = await cardAndCashRequest();
      const card = (await refunds.get(requestId)).payouts.find((p) => p.method === 'CARD')!;
      const results = await Promise.allSettled([
        refunds.sendCardPayout(op, requestId, card.partIndex),
        refunds.sendCardPayout(op, requestId, card.partIndex),
      ]);
      expect(gateway.refunds).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });

    it('kart parcasi elle "odendi" denemez; IBAN parcasi dekontla kapanir', async () => {
      const op = await operator();
      const c = await user();
      await cardTopUp(c, 3000, 400); // 365 gunu asmis: IBAN
      await cardTopUp(c, 2000, 5);
      const { refundRequestId } = await accounts.deleteAccount(c.userId, {
        balanceChoice: 'REFUND',
        iban: VALID_IBAN,
      });
      const view = await refunds.get(refundRequestId!);
      expect(view.iban).toBe(VALID_IBAN);
      expect(view.transferDescription).toBe(`QWASH-REFUND-${c.userId}`);
      const card = view.payouts.find((p) => p.method === 'CARD')!;
      const iban = view.payouts.find((p) => p.method === 'IBAN')!;
      expect([card.amountKurus, iban.amountKurus]).toEqual([2000, 3000]);

      await expect(
        refunds.resolvePayout(op, refundRequestId!, card.partIndex, {
          outcome: 'PAID',
          reference: 'elle',
        }),
      ).rejects.toMatchObject({ code: 'PAYOUT_STATE' });

      await refunds.resolvePayout(op, refundRequestId!, iban.partIndex, {
        outcome: 'PAID',
        reference: 'EFT dekont 2026-0001',
      });
      const done = await refunds.sendCardPayout(op, refundRequestId!, card.partIndex);
      expect(done.status).toBe('COMPLETED');
      expect(await balance(c.walletId)).toEqual({ balance: 0, hold: 0 });
    });

    it('red: odenmis parca yoksa bloke serbest kalir; varsa reddedilemez', async () => {
      const op = await operator();
      const first = await cardAndCashRequest();
      const rejected = await refunds.reject(op, first.requestId, 'Musteri talebini geri cekti');
      expect(rejected).toMatchObject({
        status: 'REJECTED',
        rejectReason: 'Musteri talebini geri cekti',
      });
      expect(await balance(first.c.walletId)).toEqual({ balance: 8500, hold: 0 });

      const second = await cardAndCashRequest();
      const card = (await refunds.get(second.requestId)).payouts.find((p) => p.method === 'CARD')!;
      await refunds.sendCardPayout(op, second.requestId, card.partIndex);
      await expect(
        refunds.reject(op, second.requestId, 'Artik reddetmek istiyoruz'),
      ).rejects.toMatchObject({ code: 'REFUND_HAS_PAID_PARTS' });
    });
  });

  // -------------------------------------------------------------------------

  describe('HTTP ve yetki', () => {
    let app: INestApplication;
    let auth: AuthService;

    beforeEach(async () => {
      auth = new AuthService(prisma, {
        accessSecret: 'a'.repeat(40),
        customerAppUrl: 'http://app.test',
        mailer: new CapturingMailer(),
        google: null,
      });
      const moduleRef = await Test.createTestingModule({
        imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
        controllers: [AdminController],
        providers: [
          { provide: AuthService, useValue: auth },
          { provide: PrismaService, useValue: prisma },
          { provide: AdminService, useValue: admin },
          { provide: RefundAdminService, useValue: refunds },
          { provide: APP_GUARD, useClass: ThrottlerGuard },
          AdminGuard,
        ],
      }).compile();
      app = moduleRef.createNestApplication();
      configureApp(app, ['http://admin.test']);
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    const http = () => request(app.getHttpServer());

    async function tokenFor(role: UserRole): Promise<{ token: string; userId: string }> {
      seq += 1;
      const session = await auth.register({
        email: `h${seq}@test.local`,
        password: 'gizli-sifre-1',
        fullName: 'Admin Kisi',
      });
      await prisma.user.update({
        where: { id: session.user.id },
        data: { role, emailVerifiedAt: new Date() },
      });
      return { token: session.accessToken, userId: session.user.id };
    }

    it('girissiz 401, musteri 403', async () => {
      await http().get('/api/v1/admin/me').expect(401);
      const { token } = await tokenFor(UserRole.USER);
      const res = await http()
        .get('/api/v1/admin/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      expect(res.body.error.code).toBe('ADMIN_FORBIDDEN');
    });

    it('yetkisi alinan admin ayni token ile hemen reddedilir', async () => {
      const { token, userId } = await tokenFor(UserRole.ADMIN);
      const me = await http()
        .get('/api/v1/admin/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(me.body.data).toMatchObject({ id: userId, role: 'ADMIN' });

      await prisma.user.update({ where: { id: userId }, data: { role: UserRole.USER } });
      await http().get('/api/v1/admin/me').set('Authorization', `Bearer ${token}`).expect(403);

      await prisma.user.update({
        where: { id: userId },
        data: { role: UserRole.ADMIN, status: UserStatus.SUSPENDED },
      });
      await http().get('/api/v1/admin/me').set('Authorization', `Bearer ${token}`).expect(401);
    });

    it('yukleme ayarlarini yalniz SUPER_ADMIN degistirir; degisiklik denetime yazilir', async () => {
      const body = { minTopUpKurus: 10000, maxTopUpKurus: 300000 };
      const a = await tokenFor(UserRole.ADMIN);
      // Bakiye duzeltme de yalniz SUPER_ADMIN (kaynagi olmayan para yaratabilir).
      await http()
        .post(`/api/v1/admin/users/${a.userId}/adjustments`)
        .set('Authorization', `Bearer ${a.token}`)
        .set('Idempotency-Key', 'adj')
        .send({ direction: 'CREDIT', amountKurus: 100, reason: 'Kendi hesabima para ekliyorum' })
        .expect(403);
      expect(await prisma.ledgerEntry.count()).toBe(0);
      await http()
        .put('/api/v1/admin/settings/topup')
        .set('Authorization', `Bearer ${a.token}`)
        .send(body)
        .expect(403);

      const s = await tokenFor(UserRole.SUPER_ADMIN);
      const res = await http()
        .put('/api/v1/admin/settings/topup')
        .set('Authorization', `Bearer ${s.token}`)
        .send(body)
        .expect(200);
      expect(res.body.data).toMatchObject(body);
      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: 'TOPUP_SETTINGS_UPDATED' },
      });
      expect(audit.details).toMatchObject({
        before: { minTopUpKurus: 5000, maxTopUpKurus: 500000 },
        after: body,
      });

      await http()
        .put('/api/v1/admin/settings/topup')
        .set('Authorization', `Bearer ${s.token}`)
        .send({ minTopUpKurus: 10000, maxTopUpKurus: 5000 })
        .expect(400);
    });

    it('nakit yukleme Idempotency-Key ister; arama ve kullanici detayi calisir', async () => {
      const { token } = await tokenFor(UserRole.ADMIN);
      const st = await station();
      const c = await user({ fullName: 'Mehmet Kaya' });
      const body = { userId: c.userId, stationId: st, amountKurus: 5000 };

      await http()
        .post('/api/v1/admin/cash-topups')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(400);
      const receipt = await http()
        .post('/api/v1/admin/cash-topups')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'k-http')
        .send(body)
        .expect(200);
      expect(receipt.body.data).toMatchObject({ amountKurus: 5000, balanceAfterKurus: 5000 });

      const found = await http()
        .get('/api/v1/admin/users?q=kaya')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(found.body.data).toEqual([
        expect.objectContaining({ id: c.userId, balanceKurus: 5000 }),
      ]);
      const detail = await http()
        .get(`/api/v1/admin/users/${c.userId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(detail.body.data.ledger).toHaveLength(1);

      const report = await http()
        .get(`/api/v1/admin/reports/cash?date=bugun&stationId=${st}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
      expect(report.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  /** Dogrudan bir iade talebi satiri (bloke ile), kasa raporu testleri icin. */
  async function refundRequestFixture(
    c: { userId: string; walletId: string },
    amountKurus: number,
  ): Promise<string> {
    await wallets.credit({
      walletId: c.walletId,
      amountKurus,
      source: LedgerSource.CASH_TOPUP,
      idempotencyKey: `fx-${Math.random()}`,
    });
    const { hold } = await wallets.hold({
      walletId: c.walletId,
      amountKurus,
      source: LedgerSource.REFUND,
      idempotencyKey: `fx-hold-${Math.random()}`,
    });
    const r = await prisma.refundRequest.create({
      data: {
        userId: c.userId,
        walletId: c.walletId,
        holdId: hold.id,
        reason: 'ACCOUNT_DELETION',
        amountKurus,
        holderName: 'Ayse Yilmaz',
        allocation: [],
      },
    });
    return r.id;
  }
});
