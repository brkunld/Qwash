import { Injectable, Logger } from '@nestjs/common';
import {
  type AdminRefundRequest,
  RefundAllocationPartSchema,
  type ResolvePayoutRequest,
} from '@qwash/contracts';
import { z } from 'zod';
import { PrismaClient } from '../generated/prisma/client';
import type { RefundPayout, RefundRequest } from '../generated/prisma/client';
import { RefundPayoutStatus, RefundRequestStatus } from '../generated/prisma/enums';
import { PaymentGateway, PaymentProviderError } from '../payments/payment-gateway';
import { PaymentsDisabledError } from '../payments/payments.errors';
import { PrismaService } from '../prisma/prisma.service';
import { Tx, WalletService } from '../wallet/wallet.service';
import {
  PayoutNotFoundError,
  PayoutStateError,
  RefundHasPaidPartsError,
  RefundRequestClosedError,
  RefundRequestNotFoundError,
  StationNotFoundError,
  StationRequiredError,
} from './admin.errors';
import type { AdminActor } from './admin.guard';
import { writeAudit } from './audit';

const AllocationSchema = z.array(RefundAllocationPartSchema);

type RequestWithPayouts = RefundRequest & { payouts: RefundPayout[] };

export interface RefundAdminOptions {
  gateway: PaymentGateway | null;
  now?: () => Date;
}

/**
 * Iade talebinin islenmesi (ADR-0011 madde 5).
 *
 * FIFO dagilimindaki her parca bir RefundPayout'tur. Kart parcasi Iyzico'ya gitmeden once
 * IN_FLIGHT isaretlenir ve bu isaret ayri transaction'da kalicilasir; sonuc belirsizse
 * parca IN_FLIGHT'ta kalir ve otomatik yeniden denenmez (cift iade olmasin). Admin Iyzico
 * panelinden kontrol edip `resolvePayout` ile sonuclandirir.
 *
 * Tum parcalar DONE olunca iade blokesi tahsil edilir ve talep COMPLETED olur.
 */
@Injectable()
export class RefundAdminService {
  private readonly logger = new Logger(RefundAdminService.name);
  private readonly gateway: PaymentGateway | null;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaService | PrismaClient,
    private readonly wallets: WalletService,
    options: RefundAdminOptions,
  ) {
    this.gateway = options.gateway;
    this.now = options.now ?? (() => new Date());
  }

  async list(status?: RefundRequestStatus): Promise<AdminRefundRequest[]> {
    const requests = await this.prisma.refundRequest.findMany({
      where: status ? { status } : {},
      include: { payouts: { orderBy: { partIndex: 'asc' } } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return requests.map(toView);
  }

  /** Talebi parcalariyla dondurur; parcalar henuz yoksa dagilimdan olusturur. */
  async get(requestId: string): Promise<AdminRefundRequest> {
    const request = await this.prisma.$transaction(async (tx) => {
      const r = await lockRequest(tx, requestId);
      if (r.status === RefundRequestStatus.REQUESTED) await ensurePayouts(tx, r);
      return loadRequest(tx, requestId);
    });
    return toView(request);
  }

  /** Kart parcasini Iyzico'dan kismi iade eder. */
  async sendCardPayout(
    actor: AdminActor,
    requestId: string,
    partIndex: number,
  ): Promise<AdminRefundRequest> {
    if (!this.gateway) throw new PaymentsDisabledError();

    // 1) Parcayi IN_FLIGHT isaretle ve kalicilastir. Iyzico cagrisi transaction disinda.
    const claim = await this.prisma.$transaction(async (tx) => {
      const request = await lockOpenRequest(tx, requestId);
      await ensurePayouts(tx, request);
      const payout = await lockPayout(tx, requestId, partIndex);
      if (payout.method !== 'CARD') throw new PayoutStateError('Bu parca kart iadesi degil.');
      if (payout.status === RefundPayoutStatus.IN_FLIGHT) {
        throw new PayoutStateError(
          "Bu parca Iyzico'ya gonderilmis, sonucu kaydedilmemis. Iyzico panelinden kontrol edip sonuclandirin.",
        );
      }
      if (payout.status === RefundPayoutStatus.DONE) {
        throw new PayoutStateError('Bu parca zaten odendi.');
      }
      const topUp = payout.cardTopUpId
        ? await tx.cardTopUp.findUnique({ where: { id: payout.cardTopUpId } })
        : null;
      if (!topUp?.paymentTransactionId) {
        throw new PayoutStateError(
          "Kart islem kimligi yok; Iyzico'dan iade edilemez. Parcayi IBAN ile odeyin.",
        );
      }
      if (topUp.refundedKurus + payout.amountKurus > topUp.amountKurus) {
        throw new PayoutStateError('Bu kart yuklemesinden iade edilebilecek tutar asiliyor.');
      }
      await tx.refundPayout.update({
        where: { id: payout.id },
        data: {
          status: RefundPayoutStatus.IN_FLIGHT,
          operatorId: actor.userId,
          failureReason: null,
        },
      });
      await writeAudit(tx, {
        actorId: actor.userId,
        action: 'REFUND_PAYOUT_SENT',
        targetType: 'REFUND_REQUEST',
        targetId: requestId,
        details: { partIndex, amountKurus: payout.amountKurus, cardTopUpId: topUp.id },
      });
      return {
        payoutId: payout.id,
        paymentTransactionId: topUp.paymentTransactionId,
        amountKurus: payout.amountKurus,
      };
    });

    // 2) Iyzico.
    let outcome;
    try {
      outcome = await this.gateway.refundPayment(claim);
    } catch (error) {
      if (!(error instanceof PaymentProviderError)) throw error;
      // Belirsiz: iade yapilmis olabilir. IN_FLIGHT'ta birak, admin kontrol etsin.
      this.logger.warn(`Iade sonucu belirsiz (payout ${claim.payoutId}): ${error.message}`);
      return this.get(requestId);
    }

    // 3) Sonucu kaydet.
    await this.prisma.$transaction(async (tx) => {
      const request = await lockRequest(tx, requestId);
      const payout = await lockPayout(tx, requestId, partIndex);
      if (payout.status !== RefundPayoutStatus.IN_FLIGHT) return; // admin elle sonuclandirdi
      if (outcome.kind === 'REFUNDED') {
        await this.markDone(tx, payout, { reference: outcome.providerRef, stationId: null });
      } else {
        await tx.refundPayout.update({
          where: { id: payout.id },
          data: { status: RefundPayoutStatus.FAILED, failureReason: outcome.reason },
        });
      }
      await writeAudit(tx, {
        actorId: actor.userId,
        action: 'REFUND_PAYOUT_RESULT',
        targetType: 'REFUND_REQUEST',
        targetId: requestId,
        details: {
          partIndex,
          result: outcome.kind,
          ...(outcome.kind === 'REFUNDED'
            ? { providerRef: outcome.providerRef }
            : { reason: outcome.reason }),
        },
      });
      await this.finalizeIfDone(tx, actor, request);
    });
    return this.get(requestId);
  }

  /**
   * IBAN/kasa parcasini "odendi" isaretler ya da IN_FLIGHT'ta kalmis kart parcasini
   * sonuclandirir (Iyzico panelinde gorulen duruma gore).
   */
  async resolvePayout(
    actor: AdminActor,
    requestId: string,
    partIndex: number,
    input: ResolvePayoutRequest,
  ): Promise<AdminRefundRequest> {
    await this.prisma.$transaction(async (tx) => {
      const request = await lockOpenRequest(tx, requestId);
      await ensurePayouts(tx, request);
      const payout = await lockPayout(tx, requestId, partIndex);
      if (payout.status === RefundPayoutStatus.DONE) {
        throw new PayoutStateError('Bu parca zaten odendi.');
      }

      if (input.outcome === 'NOT_PAID') {
        if (payout.method !== 'CARD' || payout.status !== RefundPayoutStatus.IN_FLIGHT) {
          throw new PayoutStateError('Yalniz sonucu belirsiz kart parcasi "yapilmadi" denebilir.');
        }
        await tx.refundPayout.update({
          where: { id: payout.id },
          data: { status: RefundPayoutStatus.FAILED, failureReason: input.reason },
        });
      } else {
        if (payout.method === 'CARD' && payout.status !== RefundPayoutStatus.IN_FLIGHT) {
          throw new PayoutStateError(
            'Kart parcasi once "Iyzico ile iade et" ile gonderilmeli; elle odendi denemez.',
          );
        }
        let stationId: string | null = null;
        if (payout.method === 'CASH_AT_STATION') {
          if (!input.stationId) throw new StationRequiredError();
          const station = await tx.station.findUnique({ where: { id: input.stationId } });
          if (!station) throw new StationNotFoundError();
          stationId = station.id;
        }
        await this.markDone(tx, payout, { reference: input.reference, stationId, actor });
      }

      await writeAudit(tx, {
        actorId: actor.userId,
        action: 'REFUND_PAYOUT_RESOLVED',
        targetType: 'REFUND_REQUEST',
        targetId: requestId,
        reason: input.outcome === 'NOT_PAID' ? input.reason : null,
        details: {
          partIndex,
          method: payout.method,
          outcome: input.outcome,
          ...(input.outcome === 'PAID' ? { reference: input.reference } : {}),
        },
      });
      await this.finalizeIfDone(tx, actor, request);
    });
    return this.get(requestId);
  }

  /** Talebi reddeder, blokeyi serbest birakir. Odenmis/belirsiz parca varsa olmaz. */
  async reject(actor: AdminActor, requestId: string, reason: string): Promise<AdminRefundRequest> {
    await this.prisma.$transaction(async (tx) => {
      const request = await lockOpenRequest(tx, requestId);
      const touched = await tx.refundPayout.count({
        where: {
          refundRequestId: requestId,
          status: { in: [RefundPayoutStatus.DONE, RefundPayoutStatus.IN_FLIGHT] },
        },
      });
      if (touched > 0) throw new RefundHasPaidPartsError();
      await this.wallets.releaseTx(tx, request.holdId);
      await tx.refundRequest.update({
        where: { id: requestId },
        data: {
          status: RefundRequestStatus.REJECTED,
          rejectReason: reason,
          resolvedAt: this.now(),
          resolvedBy: actor.userId,
          contactEmail: null,
        },
      });
      await writeAudit(tx, {
        actorId: actor.userId,
        action: 'REFUND_REJECTED',
        targetType: 'REFUND_REQUEST',
        targetId: requestId,
        reason,
        details: { amountKurus: request.amountKurus },
      });
    });
    return this.get(requestId);
  }

  private async markDone(
    tx: Tx,
    payout: RefundPayout,
    opts: { reference: string; stationId: string | null; actor?: AdminActor },
  ): Promise<void> {
    await tx.refundPayout.update({
      where: { id: payout.id },
      data: {
        status: RefundPayoutStatus.DONE,
        reference: opts.reference,
        stationId: opts.stationId,
        completedAt: this.now(),
        failureReason: null,
        ...(opts.actor ? { operatorId: opts.actor.userId } : {}),
      },
    });
    if (payout.method === 'CARD' && payout.cardTopUpId) {
      await tx.cardTopUp.update({
        where: { id: payout.cardTopUpId },
        data: { refundedKurus: { increment: payout.amountKurus } },
      });
    }
  }

  /** Tum parcalar odendiyse blokeyi tahsil eder (para cuzdandan cikar) ve talebi kapatir. */
  private async finalizeIfDone(tx: Tx, actor: AdminActor, request: RefundRequest): Promise<void> {
    const payouts = await tx.refundPayout.findMany({ where: { refundRequestId: request.id } });
    if (payouts.length === 0 || payouts.some((p) => p.status !== RefundPayoutStatus.DONE)) return;
    const paid = payouts.reduce((s, p) => s + p.amountKurus, 0);
    if (paid !== request.amountKurus) {
      // Dagilim talep tutarina esit olusturulur; olmazsa para kaybi yonunde ilerlemeyiz.
      throw new PayoutStateError(
        `Parcalarin toplami (${paid}) talep tutarina (${request.amountKurus}) esit degil.`,
      );
    }
    await this.wallets.captureTx(tx, request.holdId, request.amountKurus);
    await tx.refundRequest.update({
      where: { id: request.id },
      data: {
        status: RefundRequestStatus.COMPLETED,
        resolvedAt: this.now(),
        resolvedBy: actor.userId,
        // KVKK: bildirim amaci gerceklesti.
        contactEmail: null,
      },
    });
    await writeAudit(tx, {
      actorId: actor.userId,
      action: 'REFUND_COMPLETED',
      targetType: 'REFUND_REQUEST',
      targetId: request.id,
      details: { amountKurus: request.amountKurus, parts: payouts.length },
    });
  }
}

// ---------------------------------------------------------------------------

async function lockRequest(tx: Tx, requestId: string): Promise<RefundRequest> {
  await tx.$queryRaw`SELECT "id" FROM "RefundRequest" WHERE "id" = ${requestId} FOR UPDATE`;
  const request = await tx.refundRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new RefundRequestNotFoundError();
  return request;
}

async function lockOpenRequest(tx: Tx, requestId: string): Promise<RefundRequest> {
  const request = await lockRequest(tx, requestId);
  if (request.status !== RefundRequestStatus.REQUESTED) throw new RefundRequestClosedError();
  return request;
}

async function lockPayout(tx: Tx, requestId: string, partIndex: number): Promise<RefundPayout> {
  await tx.$queryRaw`
    SELECT "id" FROM "RefundPayout"
    WHERE "refundRequestId" = ${requestId} AND "partIndex" = ${partIndex}
    FOR UPDATE`;
  const payout = await tx.refundPayout.findUnique({
    where: { refundRequestId_partIndex: { refundRequestId: requestId, partIndex } },
  });
  if (!payout) throw new PayoutNotFoundError();
  return payout;
}

/** Dagilimdaki her parca icin bir satir; tekrar cagrilinca bir sey degismez. */
async function ensurePayouts(tx: Tx, request: RefundRequest): Promise<void> {
  const parts = AllocationSchema.parse(request.allocation);
  await tx.refundPayout.createMany({
    data: parts
      .filter((p) => p.amountKurus > 0)
      .map((p, partIndex) => ({
        refundRequestId: request.id,
        partIndex,
        method: p.method,
        amountKurus: p.amountKurus,
        cardTopUpId: p.cardTopUpId,
      })),
    skipDuplicates: true,
  });
}

function loadRequest(tx: Tx, requestId: string): Promise<RequestWithPayouts> {
  return tx.refundRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { payouts: { orderBy: { partIndex: 'asc' } } },
  });
}

function toView(r: RequestWithPayouts): AdminRefundRequest {
  return {
    id: r.id,
    userId: r.userId,
    reason: r.reason,
    status: r.status,
    amountKurus: r.amountKurus,
    holderName: r.holderName,
    contactEmail: r.contactEmail,
    iban: r.iban,
    transferDescription: `QWASH-REFUND-${r.userId}`,
    payouts: r.payouts.map((p) => ({
      partIndex: p.partIndex,
      method: p.method as 'CARD' | 'IBAN' | 'CASH_AT_STATION',
      amountKurus: p.amountKurus,
      cardTopUpId: p.cardTopUpId,
      status: p.status,
      reference: p.reference,
      failureReason: p.failureReason,
      completedAt: p.completedAt?.toISOString() ?? null,
    })),
    rejectReason: r.rejectReason,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
  };
}
