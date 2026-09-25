import { Logger } from '@nestjs/common';
import type { TopUpOptions, TopUpView } from '@qwash/contracts';
import { PrismaClient } from '../generated/prisma/client';
import type { CardTopUp } from '../generated/prisma/client';
import { CardTopUpStatus, LedgerSource, UserStatus } from '../generated/prisma/enums';
import { UnauthenticatedError } from '../auth/auth.errors';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { CheckoutOutcome, PaymentGateway } from './payment-gateway';
import {
  EmailNotVerifiedError,
  FullNameRequiredError,
  PaymentProviderUnavailableError,
  PaymentsDisabledError,
  TopUpAmountOutOfRangeError,
  TopUpIdempotencyConflictError,
  TopUpNotFoundError,
} from './payments.errors';

// Kartla bakiye yukleme (Faz 5b, ADR-0003).
//
// Akis: startTopUp -> Iyzico odeme formu -> musteri 3DS -> Iyzico tarayiciyi callback'e
// yollar -> completeByToken sonucu Iyzico'dan SORAR (govdeye guvenmez) -> bakiye yuklenir.
// Webhook ve mutabakat da ayni completeByToken'i cagirir; hangisi once gelirse gelsin tek
// CREDIT olusur: PENDING/EXPIRED -> SUCCEEDED kosullu gecisi ve CREDIT ayni transaction'da,
// ledger anahtari `card-topup:<id>` benzersizdir.

export const PRESET_MULTIPLIERS = [1, 2, 4] as const;
/** Bu sureden eski PENDING yuklemeler mutabakatta Iyzico'ya sorulur. */
export const RECONCILE_AFTER_MS = 2 * 60 * 1000;
/** Bu sureden sonra hala sonuc yoksa EXPIRED isaretlenir (gec gelen basari yine islenir). */
export const EXPIRE_AFTER_MS = 60 * 60 * 1000;
/** EXPIRED yuklemeler bu sure boyunca gec basari icin tekrar sorulur. */
export const RECHECK_EXPIRED_FOR_MS = 24 * 60 * 60 * 1000;
/** Form hic acilamamis (token yok) PENDING kayitlar bu sureden sonra FAILED olur. */
export const ABANDONED_INIT_MS = 10 * 60 * 1000;

const SETTLEABLE: CardTopUpStatus[] = [CardTopUpStatus.PENDING, CardTopUpStatus.EXPIRED];

export interface PaymentsServiceOptions {
  gateway: PaymentGateway | null;
  apiPublicUrl: string;
  now?: () => Date;
}

export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaService | PrismaClient,
    private readonly wallets: WalletService,
    private readonly options: PaymentsServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async getTopUpOptions(): Promise<TopUpOptions> {
    const { minTopUpKurus, maxTopUpKurus } = await this.settings();
    return {
      minKurus: minTopUpKurus,
      maxKurus: maxTopUpKurus,
      presetsKurus: PRESET_MULTIPLIERS.map((m) => m * minTopUpKurus).filter(
        (v) => v <= maxTopUpKurus,
      ),
    };
  }

  async startTopUp(input: {
    userId: string;
    amountKurus: number;
    idempotencyKey: string;
    ip: string | null;
  }): Promise<TopUpView> {
    const gateway = this.options.gateway;
    if (!gateway) throw new PaymentsDisabledError();

    const user = await this.prisma.user.findUnique({ where: { id: input.userId } });
    if (!user || user.status !== UserStatus.ACTIVE) throw new UnauthenticatedError();
    if (!user.emailVerifiedAt) throw new EmailNotVerifiedError();
    // Muhurlenecek ad bos olamaz (Google'dan ad gelmeyebilir).
    if (!user.fullName?.trim()) throw new FullNameRequiredError();

    const { minTopUpKurus, maxTopUpKurus } = await this.settings();
    if (
      !Number.isSafeInteger(input.amountKurus) ||
      input.amountKurus < minTopUpKurus ||
      input.amountKurus > maxTopUpKurus
    ) {
      throw new TopUpAmountOutOfRangeError(minTopUpKurus, maxTopUpKurus);
    }

    const replay = await this.findByKey(input.userId, input.idempotencyKey);
    if (replay) return this.replay(replay, input.amountKurus);

    const wallet = await this.prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } });
    let topUp: CardTopUp;
    try {
      topUp = await this.prisma.cardTopUp.create({
        data: {
          userId: user.id,
          walletId: wallet.id,
          amountKurus: input.amountKurus,
          idempotencyKey: input.idempotencyKey,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Ayni anahtarla eszamanli iki istek: kazananin kaydi doner.
      const winner = await this.findByKey(input.userId, input.idempotencyKey);
      if (!winner) throw error;
      return this.replay(winner, input.amountKurus);
    }

    try {
      const checkout = await gateway.initializeCheckout({
        topUpId: topUp.id,
        amountKurus: topUp.amountKurus,
        callbackUrl: new URL(
          '/api/v1/payments/iyzico/callback',
          this.options.apiPublicUrl,
        ).toString(),
        buyer: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
          phoneNumber: user.phoneNumber,
          ip: input.ip,
        },
      });
      topUp = await this.prisma.cardTopUp.update({
        where: { id: topUp.id },
        data: { iyzicoToken: checkout.token, paymentPageUrl: checkout.paymentPageUrl },
      });
    } catch (error) {
      this.logger.error({ err: error, topUpId: topUp.id }, 'Iyzico odeme formu acilamadi');
      await this.prisma.cardTopUp.updateMany({
        where: { id: topUp.id, status: CardTopUpStatus.PENDING },
        data: {
          status: CardTopUpStatus.FAILED,
          failureReason: 'Odeme formu acilamadi',
          completedAt: this.now(),
        },
      });
      throw new PaymentProviderUnavailableError();
    }
    return toView(topUp);
  }

  async getTopUp(userId: string, topUpId: string): Promise<TopUpView> {
    const topUp = await this.prisma.cardTopUp.findFirst({ where: { id: topUpId, userId } });
    if (!topUp) throw new TopUpNotFoundError();
    return toView(topUp);
  }

  /**
   * Iyzico'dan sonucu sorar ve uygular. Callback, webhook ve mutabakat buradan gecer.
   * Bilinmeyen token icin null doner. Saglayici hatasi (ag, imza) firlatilir; durum degismez.
   */
  async completeByToken(token: string): Promise<CardTopUp | null> {
    const topUp = await this.prisma.cardTopUp.findUnique({ where: { iyzicoToken: token } });
    if (!topUp) return null;
    if (!SETTLEABLE.includes(topUp.status)) return topUp;
    if (!this.options.gateway) throw new PaymentsDisabledError();
    const outcome = await this.options.gateway.retrieveCheckout(token);
    return this.apply(topUp, outcome);
  }

  /** Mutabakat turu: sonucu gelmemis yuklemeleri Iyzico'ya sorar, suresi dolanlari isaretler. */
  async reconcile(limit = 50): Promise<{ checked: number; expired: number; abandoned: number }> {
    const now = this.now().getTime();

    const abandoned = await this.prisma.cardTopUp.updateMany({
      where: {
        status: CardTopUpStatus.PENDING,
        iyzicoToken: null,
        createdAt: { lt: new Date(now - ABANDONED_INIT_MS) },
      },
      data: {
        status: CardTopUpStatus.FAILED,
        failureReason: 'Odeme formu acilamadi',
        completedAt: new Date(now),
      },
    });

    const candidates = await this.prisma.cardTopUp.findMany({
      where: {
        iyzicoToken: { not: null },
        OR: [
          {
            status: CardTopUpStatus.PENDING,
            createdAt: { lt: new Date(now - RECONCILE_AFTER_MS) },
          },
          {
            status: CardTopUpStatus.EXPIRED,
            createdAt: { gt: new Date(now - RECHECK_EXPIRED_FOR_MS) },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    let expired = 0;
    for (const candidate of candidates) {
      let current: CardTopUp | null = candidate;
      try {
        current = await this.completeByToken(candidate.iyzicoToken!);
      } catch (error) {
        this.logger.warn(
          { err: error, topUpId: candidate.id },
          'Mutabakat: Iyzico sorgusu basarisiz',
        );
      }
      if (
        current?.status === CardTopUpStatus.PENDING &&
        current.createdAt.getTime() < now - EXPIRE_AFTER_MS
      ) {
        const { count } = await this.prisma.cardTopUp.updateMany({
          where: { id: current.id, status: CardTopUpStatus.PENDING },
          data: { status: CardTopUpStatus.EXPIRED, failureReason: 'Odeme sonucu gelmedi' },
        });
        expired += count;
      }
    }
    return { checked: candidates.length, expired, abandoned: abandoned.count };
  }

  private async apply(topUp: CardTopUp, outcome: CheckoutOutcome): Promise<CardTopUp> {
    if (outcome.kind === 'PENDING') return topUp;

    if (outcome.kind === 'FAILURE') {
      // Yalniz PENDING basarisiz olur; EXPIRED zaten sonuclanmamis sayilir, dokunulmaz.
      await this.prisma.cardTopUp.updateMany({
        where: { id: topUp.id, status: CardTopUpStatus.PENDING },
        data: {
          status: CardTopUpStatus.FAILED,
          failureReason: outcome.reason,
          completedAt: this.now(),
        },
      });
      return this.prisma.cardTopUp.findUniqueOrThrow({ where: { id: topUp.id } });
    }

    const mismatch = [
      outcome.paidKurus !== topUp.amountKurus &&
        `tutar ${outcome.paidKurus} != ${topUp.amountKurus}`,
      outcome.currency !== 'TRY' && `para birimi ${outcome.currency}`,
      outcome.basketId !== topUp.id && `basketId ${outcome.basketId}`,
      outcome.conversationId !== topUp.id && `conversationId ${outcome.conversationId}`,
    ].filter(Boolean);
    if (mismatch.length > 0) {
      // Para cekilmis ama beklenenle uyusmuyor: bakiye yuklenmez, admin incelemesine kalir.
      this.logger.error(
        { topUpId: topUp.id, mismatch, paymentId: outcome.paymentId },
        'Kart yukleme uyusmazligi',
      );
      await this.prisma.cardTopUp.updateMany({
        where: { id: topUp.id, status: { in: SETTLEABLE } },
        data: {
          status: CardTopUpStatus.FAILED,
          failureReason: `INCELEME: ${mismatch.join(', ')}`,
          iyzicoPaymentId: outcome.paymentId,
          paymentTransactionId: outcome.paymentTransactionId,
          completedAt: this.now(),
        },
      });
      return this.prisma.cardTopUp.findUniqueOrThrow({ where: { id: topUp.id } });
    }

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.cardTopUp.updateMany({
        where: { id: topUp.id, status: { in: SETTLEABLE } },
        data: {
          status: CardTopUpStatus.SUCCEEDED,
          iyzicoPaymentId: outcome.paymentId,
          paymentTransactionId: outcome.paymentTransactionId,
          failureReason: null,
          completedAt: this.now(),
        },
      });
      if (count === 1) {
        // Ilk basarili yuklemede ad muhurlenir (IBAN iadesinde alici adi karsilastirmasi).
        await tx.user.updateMany({
          where: { id: topUp.userId, nameLockedAt: null },
          data: { nameLockedAt: this.now() },
        });
        await this.wallets.creditTx(tx, {
          walletId: topUp.walletId,
          amountKurus: topUp.amountKurus,
          source: LedgerSource.CARD_TOPUP,
          idempotencyKey: `card-topup:${topUp.id}`,
          referenceId: topUp.id,
        });
      }
      return tx.cardTopUp.findUniqueOrThrow({ where: { id: topUp.id } });
    });
  }

  private replay(existing: CardTopUp, amountKurus: number): TopUpView {
    if (existing.amountKurus !== amountKurus) throw new TopUpIdempotencyConflictError();
    return toView(existing);
  }

  private findByKey(userId: string, idempotencyKey: string): Promise<CardTopUp | null> {
    return this.prisma.cardTopUp.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
    });
  }

  private async settings(): Promise<{ minTopUpKurus: number; maxTopUpKurus: number }> {
    return this.prisma.topUpSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  }
}

function toView(topUp: CardTopUp): TopUpView {
  return {
    topUpId: topUp.id,
    status: topUp.status,
    amountKurus: topUp.amountKurus,
    paymentPageUrl: topUp.status === CardTopUpStatus.PENDING ? topUp.paymentPageUrl : null,
    // INCELEME ayrintisi musteriye gosterilmez.
    failureReason: topUp.failureReason?.startsWith('INCELEME')
      ? 'Odeme inceleniyor'
      : topUp.failureReason,
    createdAt: topUp.createdAt.toISOString(),
    completedAt: topUp.completedAt?.toISOString() ?? null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}
