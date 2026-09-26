import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import type { LedgerEntry, WalletHold } from '../generated/prisma/client';
import { HoldStatus, LedgerSource, LedgerType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import {
  CaptureExceedsHoldError,
  HoldAlreadySettledError,
  HoldNotFoundError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidAmountError,
  WalletNotFoundError,
} from './wallet.errors';

export type Tx = Prisma.TransactionClient;

export interface WalletBalance {
  walletId: string;
  balanceKurus: number;
  holdKurus: number;
  availableKurus: number;
}

export interface CreditInput {
  walletId: string;
  amountKurus: number;
  source: LedgerSource;
  idempotencyKey: string;
  referenceId?: string;
  note?: string;
}

export interface HoldInput {
  walletId: string;
  amountKurus: number;
  source: LedgerSource;
  idempotencyKey: string;
  referenceId?: string;
}

export interface HoldResult {
  hold: WalletHold;
  balance: WalletBalance;
}

interface WalletRow {
  balanceKurus: bigint;
  holdKurus: bigint;
}

/**
 * Cuzdan ve ledger islemleri (ADR-0004).
 *
 * Tutarlilik garantileri:
 * - Bakiye/bloke degisikligi ve ledger kaydi ayni transaction'da yazilir.
 * - Bakiye kontrolu ve guncellemesi tek bir kosullu UPDATE ile yapilir; eszamanli
 *   istekler bakiyeyi eksiye dusuremez. DB CHECK constraint'leri son savunma hattidir.
 * - Bloke satiri tahsil/serbest birakma sirasinda FOR UPDATE ile kilitlenir; bir bloke
 *   yalnizca bir kez kapatilabilir.
 * - Tum giris noktalari idempotenttir (ayni anahtar = ayni sonuc, cift hareket yok).
 */
@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService | PrismaClient) {}

  async createWallet(userId: string): Promise<WalletBalance> {
    const wallet = await this.prisma.wallet.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    return toBalance(wallet.id, wallet);
  }

  async getBalance(walletId: string): Promise<WalletBalance> {
    const wallet = await this.prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) throw new WalletNotFoundError(walletId);
    return toBalance(wallet.id, wallet);
  }

  /** Bakiyeye para ekler (kart/nakit yukleme, iade). */
  async credit(input: CreditInput): Promise<LedgerEntry> {
    const amount = toAmount(input.amountKurus);

    const existing = await this.findLedgerByKey(input.idempotencyKey);
    if (existing) return assertSameCredit(existing, input, amount);

    try {
      return await this.prisma.$transaction((tx) => this.creditTx(tx, input));
    } catch (error) {
      // Ayni anahtarla eszamanli iki istek: kaybeden transaction geri alinir,
      // kazananin kaydi dondurulur.
      if (isUniqueViolation(error)) {
        const winner = await this.findLedgerByKey(input.idempotencyKey);
        if (winner) return assertSameCredit(winner, input, amount);
      }
      throw error;
    }
  }

  /**
   * `credit`'in transaction icinde calisan hali (ornegin kart yuklemesinin durumu ile
   * ayni transaction'da). Ayni anahtarla ikinci cagri unique ihlaliyle geri alinir.
   */
  async creditTx(tx: Tx, input: CreditInput): Promise<LedgerEntry> {
    const amount = toAmount(input.amountKurus);
    const [row] = await tx.$queryRaw<WalletRow[]>`
      UPDATE "Wallet"
      SET "balanceKurus" = "balanceKurus" + ${amount}, "updatedAt" = now()
      WHERE "id" = ${input.walletId}
      RETURNING "balanceKurus", "holdKurus"`;
    if (!row) throw new WalletNotFoundError(input.walletId);

    return tx.ledgerEntry.create({
      data: {
        walletId: input.walletId,
        type: LedgerType.CREDIT,
        source: input.source,
        amountKurus: amount,
        balanceAfterKurus: row.balanceKurus,
        holdAfterKurus: row.holdKurus,
        referenceId: input.referenceId ?? null,
        idempotencyKey: input.idempotencyKey,
        note: input.note ?? null,
      },
    });
  }

  /** Kullanilabilir bakiyeden tutar bloke eder (seans baslangici). */
  async hold(input: HoldInput): Promise<HoldResult> {
    const amount = toAmount(input.amountKurus);

    const existing = await this.findHoldByKey(input.idempotencyKey);
    if (existing) return this.replayHold(existing, input, amount);

    try {
      return await this.prisma.$transaction((tx) => this.holdTx(tx, input));
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await this.findHoldByKey(input.idempotencyKey);
        if (winner) return this.replayHold(winner, input, amount);
      }
      throw error;
    }
  }

  /**
   * Blokenin `captureKurus` kadarini kalici tahsil eder, kalanini serbest birakir.
   * Ornek: 3000 bloke, 1800 kullanildi -> 1800 CAPTURE + 1200 RELEASE.
   * Ayni tutarla tekrar cagrilirsa idempotent olarak mevcut sonucu dondurur.
   */
  async capture(holdId: string, captureKurus: number): Promise<HoldResult> {
    return this.prisma.$transaction((tx) => this.captureTx(tx, holdId, captureKurus));
  }

  /** Blokeyi tamamen serbest birakir (ornegin cihaz START ACK vermedi). Idempotenttir. */
  async release(holdId: string): Promise<HoldResult> {
    return this.prisma.$transaction((tx) => this.releaseTx(tx, holdId));
  }

  /**
   * `hold`'un transaction icinde calisan hali: cagiran kendi kayitlarini (seans, outbox)
   * ayni transaction'da yazar. Idempotency tekrari cagiranin sorumlulugundadir; ayni
   * anahtarla ikinci cagri unique ihlaliyle tum transaction'i geri alir.
   */
  async holdTx(tx: Tx, input: HoldInput): Promise<HoldResult> {
    const amount = toAmount(input.amountKurus);
    const [row] = await tx.$queryRaw<WalletRow[]>`
      UPDATE "Wallet"
      SET "holdKurus" = "holdKurus" + ${amount}, "updatedAt" = now()
      WHERE "id" = ${input.walletId}
        AND "balanceKurus" - "holdKurus" >= ${amount}
      RETURNING "balanceKurus", "holdKurus"`;
    if (!row) await this.throwHoldRejected(tx, input.walletId, amount);

    const hold = await tx.walletHold.create({
      data: {
        walletId: input.walletId,
        amountKurus: amount,
        source: input.source,
        referenceId: input.referenceId ?? null,
        idempotencyKey: input.idempotencyKey,
      },
    });
    await tx.ledgerEntry.create({
      data: {
        walletId: input.walletId,
        type: LedgerType.HOLD,
        source: input.source,
        amountKurus: amount,
        balanceAfterKurus: row!.balanceKurus,
        holdAfterKurus: row!.holdKurus,
        holdId: hold.id,
        referenceId: input.referenceId ?? null,
      },
    });
    return { hold, balance: toBalance(input.walletId, row!) };
  }

  /** `capture`'in transaction icinde calisan hali. */
  async captureTx(tx: Tx, holdId: string, captureKurus: number): Promise<HoldResult> {
    if (!Number.isSafeInteger(captureKurus) || captureKurus < 0) {
      throw new InvalidAmountError(captureKurus);
    }
    const capture = BigInt(captureKurus);
    const hold = await lockHold(tx, holdId);
    if (hold.status !== HoldStatus.ACTIVE) {
      // capture(0) blokeyi RELEASED olarak kapatir; ayni cagrinin tekrari da idempotenttir.
      const sameResult =
        hold.capturedKurus === capture && (hold.status === HoldStatus.CAPTURED || capture === 0n);
      if (sameResult) {
        return { hold, balance: await this.balanceIn(tx, hold.walletId) };
      }
      throw new HoldAlreadySettledError(holdId, hold.status);
    }
    if (capture > hold.amountKurus) {
      throw new CaptureExceedsHoldError(captureKurus, Number(hold.amountKurus));
    }

    const remainder = hold.amountKurus - capture;
    const [row] = await tx.$queryRaw<WalletRow[]>`
      UPDATE "Wallet"
      SET "balanceKurus" = "balanceKurus" - ${capture},
          "holdKurus" = "holdKurus" - ${hold.amountKurus},
          "updatedAt" = now()
      WHERE "id" = ${hold.walletId}
      RETURNING "balanceKurus", "holdKurus"`;

    if (capture > 0n) {
      await tx.ledgerEntry.create({
        data: {
          walletId: hold.walletId,
          type: LedgerType.CAPTURE,
          source: hold.source,
          amountKurus: capture,
          balanceAfterKurus: row!.balanceKurus,
          holdAfterKurus: row!.holdKurus + remainder,
          holdId,
          referenceId: hold.referenceId,
        },
      });
    }
    if (remainder > 0n) {
      await tx.ledgerEntry.create({
        data: {
          walletId: hold.walletId,
          type: LedgerType.RELEASE,
          source: hold.source,
          amountKurus: remainder,
          balanceAfterKurus: row!.balanceKurus,
          holdAfterKurus: row!.holdKurus,
          holdId,
          referenceId: hold.referenceId,
        },
      });
    }

    const settled = await tx.walletHold.update({
      where: { id: holdId },
      data: {
        status: capture > 0n ? HoldStatus.CAPTURED : HoldStatus.RELEASED,
        capturedKurus: capture,
        settledAt: new Date(),
      },
    });
    return { hold: settled, balance: toBalance(hold.walletId, row!) };
  }

  /** `release`'in transaction icinde calisan hali. */
  async releaseTx(tx: Tx, holdId: string): Promise<HoldResult> {
    const hold = await lockHold(tx, holdId);
    if (hold.status === HoldStatus.RELEASED) {
      return { hold, balance: await this.balanceIn(tx, hold.walletId) };
    }
    if (hold.status !== HoldStatus.ACTIVE) {
      throw new HoldAlreadySettledError(holdId, hold.status);
    }

    const [row] = await tx.$queryRaw<WalletRow[]>`
      UPDATE "Wallet"
      SET "holdKurus" = "holdKurus" - ${hold.amountKurus}, "updatedAt" = now()
      WHERE "id" = ${hold.walletId}
      RETURNING "balanceKurus", "holdKurus"`;

    await tx.ledgerEntry.create({
      data: {
        walletId: hold.walletId,
        type: LedgerType.RELEASE,
        source: hold.source,
        amountKurus: hold.amountKurus,
        balanceAfterKurus: row!.balanceKurus,
        holdAfterKurus: row!.holdKurus,
        holdId,
        referenceId: hold.referenceId,
      },
    });

    const settled = await tx.walletHold.update({
      where: { id: holdId },
      data: { status: HoldStatus.RELEASED, settledAt: new Date() },
    });
    return { hold: settled, balance: toBalance(hold.walletId, row!) };
  }

  private findLedgerByKey(idempotencyKey: string): Promise<LedgerEntry | null> {
    return this.prisma.ledgerEntry.findUnique({ where: { idempotencyKey } });
  }

  private findHoldByKey(idempotencyKey: string): Promise<WalletHold | null> {
    return this.prisma.walletHold.findUnique({ where: { idempotencyKey } });
  }

  private async replayHold(
    hold: WalletHold,
    input: HoldInput,
    amount: bigint,
  ): Promise<HoldResult> {
    if (hold.walletId !== input.walletId || hold.amountKurus !== amount) {
      throw new IdempotencyConflictError(input.idempotencyKey);
    }
    return { hold, balance: await this.getBalance(hold.walletId) };
  }

  private async balanceIn(tx: Tx, walletId: string): Promise<WalletBalance> {
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
    return toBalance(walletId, wallet);
  }

  private async throwHoldRejected(tx: Tx, walletId: string, amount: bigint): Promise<never> {
    const wallet = await tx.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) throw new WalletNotFoundError(walletId);
    throw new InsufficientFundsError(
      Number(amount),
      Number(wallet.balanceKurus - wallet.holdKurus),
    );
  }
}

async function lockHold(tx: Tx, holdId: string): Promise<WalletHold> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "WalletHold" WHERE "id" = ${holdId} FOR UPDATE`;
  if (locked.length === 0) throw new HoldNotFoundError(holdId);
  return tx.walletHold.findUniqueOrThrow({ where: { id: holdId } });
}

function toAmount(value: number): bigint {
  if (!Number.isSafeInteger(value) || value <= 0) throw new InvalidAmountError(value);
  return BigInt(value);
}

function toBalance(walletId: string, w: WalletRow): WalletBalance {
  return {
    walletId,
    balanceKurus: Number(w.balanceKurus),
    holdKurus: Number(w.holdKurus),
    availableKurus: Number(w.balanceKurus - w.holdKurus),
  };
}

function assertSameCredit(entry: LedgerEntry, input: CreditInput, amount: bigint): LedgerEntry {
  if (
    entry.walletId !== input.walletId ||
    entry.amountKurus !== amount ||
    entry.type !== LedgerType.CREDIT
  ) {
    throw new IdempotencyConflictError(input.idempotencyKey);
  }
  return entry;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
