import { PrismaClient } from '../src/generated/prisma/client';
import { HoldStatus, LedgerSource, LedgerType } from '../src/generated/prisma/enums';
import {
  CaptureExceedsHoldError,
  HoldAlreadySettledError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidAmountError,
} from '../src/wallet/wallet.errors';
import { WalletService } from '../src/wallet/wallet.service';
import { resetDatabase, testPrisma } from './db';

describe('WalletService (gercek PostgreSQL)', () => {
  let prisma: PrismaClient;
  let wallets: WalletService;
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
  });

  async function walletWith(balanceKurus: number): Promise<string> {
    seq += 1;
    const user = await prisma.user.create({ data: { email: `u${seq}@test.local` } });
    const { walletId } = await wallets.createWallet(user.id);
    if (balanceKurus > 0) {
      await wallets.credit({
        walletId,
        amountKurus: balanceKurus,
        source: LedgerSource.CARD_TOPUP,
        idempotencyKey: `setup-${seq}`,
      });
    }
    return walletId;
  }

  async function ledgerTypes(walletId: string): Promise<LedgerType[]> {
    const entries = await prisma.ledgerEntry.findMany({
      where: { walletId },
      orderBy: { createdAt: 'asc' },
    });
    return entries.map((e) => e.type);
  }

  /** Ledger'dan yeniden hesaplanan bakiye/bloke, cuzdandaki degerle ayni olmali. */
  async function expectLedgerMatchesWallet(walletId: string): Promise<void> {
    const entries = await prisma.ledgerEntry.findMany({ where: { walletId } });
    let balance = 0n;
    let hold = 0n;
    for (const e of entries) {
      if (e.type === LedgerType.CREDIT) balance += e.amountKurus;
      if (e.type === LedgerType.DEBIT) balance -= e.amountKurus;
      if (e.type === LedgerType.HOLD) hold += e.amountKurus;
      if (e.type === LedgerType.CAPTURE) {
        balance -= e.amountKurus;
        hold -= e.amountKurus;
      }
      if (e.type === LedgerType.RELEASE) hold -= e.amountKurus;
    }
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
    expect({ balance: wallet.balanceKurus, hold: wallet.holdKurus }).toEqual({ balance, hold });
  }

  describe('credit', () => {
    it('bakiyeyi artirir ve ledger kaydi yazar', async () => {
      const walletId = await walletWith(0);
      const entry = await wallets.credit({
        walletId,
        amountKurus: 10000,
        source: LedgerSource.CASH_TOPUP,
        idempotencyKey: 'k1',
      });

      expect(entry.type).toBe(LedgerType.CREDIT);
      expect(entry.balanceAfterKurus).toBe(10000n);
      expect(await wallets.getBalance(walletId)).toMatchObject({
        balanceKurus: 10000,
        availableKurus: 10000,
      });
    });

    it('ayni idempotency anahtari ikinci kez bakiye eklemez', async () => {
      const walletId = await walletWith(0);
      const input = {
        walletId,
        amountKurus: 5000,
        source: LedgerSource.CARD_TOPUP,
        idempotencyKey: 'odeme-123',
      };
      const first = await wallets.credit(input);
      const second = await wallets.credit(input);

      expect(second.id).toBe(first.id);
      expect((await wallets.getBalance(walletId)).balanceKurus).toBe(5000);
    });

    it('ayni anahtarla eszamanli 10 istek yalnizca bir kez yukler', async () => {
      const walletId = await walletWith(0);
      const input = {
        walletId,
        amountKurus: 2500,
        source: LedgerSource.CARD_TOPUP,
        idempotencyKey: 'webhook-tekrar',
      };
      const results = await Promise.all(Array.from({ length: 10 }, () => wallets.credit(input)));

      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect((await wallets.getBalance(walletId)).balanceKurus).toBe(2500);
      await expectLedgerMatchesWallet(walletId);
    });

    it('ayni anahtar farkli tutarla kullanilirsa reddeder', async () => {
      const walletId = await walletWith(0);
      const base = { walletId, source: LedgerSource.CARD_TOPUP, idempotencyKey: 'k' };
      await wallets.credit({ ...base, amountKurus: 100 });

      await expect(wallets.credit({ ...base, amountKurus: 999 })).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
    });

    it('sifir, negatif veya kesirli tutari reddeder', async () => {
      const walletId = await walletWith(0);
      for (const amountKurus of [0, -100, 10.5]) {
        await expect(
          wallets.credit({
            walletId,
            amountKurus,
            source: LedgerSource.CARD_TOPUP,
            idempotencyKey: `bad-${amountKurus}`,
          }),
        ).rejects.toBeInstanceOf(InvalidAmountError);
      }
    });
  });

  describe('hold / capture / release', () => {
    it('kismi kullanim: 3000 bloke, 1800 tahsil, 1200 serbest', async () => {
      const walletId = await walletWith(10000);
      const { hold, balance } = await wallets.hold({
        walletId,
        amountKurus: 3000,
        source: LedgerSource.SESSION,
        idempotencyKey: 'seans-1',
        referenceId: 'session-1',
      });
      expect(balance).toMatchObject({ balanceKurus: 10000, holdKurus: 3000, availableKurus: 7000 });

      const result = await wallets.capture(hold.id, 1800);

      expect(result.balance).toMatchObject({
        balanceKurus: 8200,
        holdKurus: 0,
        availableKurus: 8200,
      });
      expect(result.hold.status).toBe(HoldStatus.CAPTURED);
      expect(result.hold.capturedKurus).toBe(1800n);
      expect(await ledgerTypes(walletId)).toEqual([
        LedgerType.CREDIT,
        LedgerType.HOLD,
        LedgerType.CAPTURE,
        LedgerType.RELEASE,
      ]);
      await expectLedgerMatchesWallet(walletId);
    });

    it('yetersiz bakiyede bloke reddedilir ve hicbir sey yazilmaz', async () => {
      const walletId = await walletWith(1000);

      await expect(
        wallets.hold({
          walletId,
          amountKurus: 1001,
          source: LedgerSource.SESSION,
          idempotencyKey: 'fazla',
        }),
      ).rejects.toBeInstanceOf(InsufficientFundsError);

      expect(await ledgerTypes(walletId)).toEqual([LedgerType.CREDIT]);
      expect(await prisma.walletHold.count()).toBe(0);
    });

    it('bloke edilen tutar kullanilabilir bakiyeden duser', async () => {
      const walletId = await walletWith(5000);
      await wallets.hold({
        walletId,
        amountKurus: 4000,
        source: LedgerSource.SESSION,
        idempotencyKey: 'a',
      });

      await expect(
        wallets.hold({
          walletId,
          amountKurus: 2000,
          source: LedgerSource.SESSION,
          idempotencyKey: 'b',
        }),
      ).rejects.toBeInstanceOf(InsufficientFundsError);
    });

    it('bloke edilenden fazla tahsil edilemez', async () => {
      const walletId = await walletWith(5000);
      const { hold } = await wallets.hold({
        walletId,
        amountKurus: 1000,
        source: LedgerSource.SESSION,
        idempotencyKey: 'h',
      });

      await expect(wallets.capture(hold.id, 1001)).rejects.toBeInstanceOf(CaptureExceedsHoldError);
      expect((await wallets.getBalance(walletId)).holdKurus).toBe(1000);
    });

    it('ayni tahsil tekrar gelirse idempotent, farkli tutarla gelirse reddedilir', async () => {
      const walletId = await walletWith(5000);
      const { hold } = await wallets.hold({
        walletId,
        amountKurus: 2000,
        source: LedgerSource.SESSION,
        idempotencyKey: 'h',
      });
      await wallets.capture(hold.id, 1500);

      const again = await wallets.capture(hold.id, 1500);
      expect(again.balance.balanceKurus).toBe(3500);
      await expect(wallets.capture(hold.id, 1000)).rejects.toBeInstanceOf(HoldAlreadySettledError);
      await expectLedgerMatchesWallet(walletId);
    });

    it('release blokeyi geri verir; tekrar release idempotent; sonrasinda tahsil reddedilir', async () => {
      const walletId = await walletWith(5000);
      const { hold } = await wallets.hold({
        walletId,
        amountKurus: 2000,
        source: LedgerSource.SESSION,
        idempotencyKey: 'h',
      });

      const released = await wallets.release(hold.id);
      expect(released.balance).toMatchObject({ balanceKurus: 5000, holdKurus: 0 });
      expect((await wallets.release(hold.id)).hold.status).toBe(HoldStatus.RELEASED);
      await expect(wallets.capture(hold.id, 100)).rejects.toBeInstanceOf(HoldAlreadySettledError);
      expect(await ledgerTypes(walletId)).toEqual([
        LedgerType.CREDIT,
        LedgerType.HOLD,
        LedgerType.RELEASE,
      ]);
    });

    it('0 saniyelik kullanim (capture 0) blokeyi tamamen serbest birakir', async () => {
      const walletId = await walletWith(5000);
      const { hold } = await wallets.hold({
        walletId,
        amountKurus: 2000,
        source: LedgerSource.SESSION,
        idempotencyKey: 'h',
      });

      const result = await wallets.capture(hold.id, 0);
      expect(result.hold.status).toBe(HoldStatus.RELEASED);
      expect(result.balance).toMatchObject({ balanceKurus: 5000, holdKurus: 0 });
      expect((await wallets.capture(hold.id, 0)).hold.status).toBe(HoldStatus.RELEASED);
    });

    it('ayni anahtarla tekrar bloke istegi ikinci bloke olusturmaz', async () => {
      const walletId = await walletWith(5000);
      const input = {
        walletId,
        amountKurus: 1000,
        source: LedgerSource.SESSION,
        idempotencyKey: 'h',
      };
      const a = await wallets.hold(input);
      const b = await wallets.hold(input);

      expect(b.hold.id).toBe(a.hold.id);
      expect((await wallets.getBalance(walletId)).holdKurus).toBe(1000);
    });
  });

  describe('eszamanlilik', () => {
    it('5000 bakiye, 20 eszamanli 1000 bloke: tam 5 tanesi basarili', async () => {
      const walletId = await walletWith(5000);
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          wallets.hold({
            walletId,
            amountKurus: 1000,
            source: LedgerSource.SESSION,
            idempotencyKey: `paralel-${i}`,
          }),
        ),
      );

      const ok = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(5);
      expect(rejected).toHaveLength(15);
      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientFundsError);
      }
      expect(await wallets.getBalance(walletId)).toMatchObject({
        balanceKurus: 5000,
        holdKurus: 5000,
        availableKurus: 0,
      });
      await expectLedgerMatchesWallet(walletId);
    });

    it('ayni blokeye eszamanli 10 tahsil: para yalnizca bir kez duser', async () => {
      const walletId = await walletWith(5000);
      const { hold } = await wallets.hold({
        walletId,
        amountKurus: 3000,
        source: LedgerSource.SESSION,
        idempotencyKey: 'h',
      });

      await Promise.allSettled(Array.from({ length: 10 }, () => wallets.capture(hold.id, 2000)));

      expect(await wallets.getBalance(walletId)).toMatchObject({
        balanceKurus: 3000,
        holdKurus: 0,
      });
      const captures = await prisma.ledgerEntry.count({
        where: { walletId, type: LedgerType.CAPTURE },
      });
      expect(captures).toBe(1);
      await expectLedgerMatchesWallet(walletId);
    });

    it('ayni blokeye eszamanli tahsil ve serbest birakma: yalnizca biri uygulanir', async () => {
      const walletId = await walletWith(5000);
      const { hold } = await wallets.hold({
        walletId,
        amountKurus: 3000,
        source: LedgerSource.SESSION,
        idempotencyKey: 'h',
      });

      await Promise.allSettled([wallets.capture(hold.id, 1000), wallets.release(hold.id)]);

      const settled = await prisma.walletHold.findUniqueOrThrow({ where: { id: hold.id } });
      expect(settled.status).not.toBe(HoldStatus.ACTIVE);
      expect((await wallets.getBalance(walletId)).holdKurus).toBe(0);
      await expectLedgerMatchesWallet(walletId);
    });
  });

  describe('veritabani kurallari (son savunma hatti)', () => {
    it('ledger kaydi guncellenemez', async () => {
      const walletId = await walletWith(1000);
      const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { walletId } });

      await expect(
        prisma.ledgerEntry.update({ where: { id: entry.id }, data: { note: 'degistirildi' } }),
      ).rejects.toThrow(/degistirilemez/);
    });

    it('ledger kaydi silinemez', async () => {
      const walletId = await walletWith(1000);
      const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { walletId } });

      await expect(prisma.ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
        /degistirilemez/,
      );
    });

    it('servisi atlayan dogrudan SQL bile bakiyeyi blokenin altina indiremez', async () => {
      const walletId = await walletWith(1000);
      await wallets.hold({
        walletId,
        amountKurus: 800,
        source: LedgerSource.SESSION,
        idempotencyKey: 'h',
      });

      await expect(
        prisma.$executeRaw`UPDATE "Wallet" SET "balanceKurus" = 500 WHERE "id" = ${walletId}`,
      ).rejects.toThrow(/Wallet_balance_covers_hold/);
    });
  });
});
