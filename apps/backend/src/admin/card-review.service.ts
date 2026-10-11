import type { AdminCardTopUpReview } from '@qwash/contracts';
import { PrismaClient } from '../generated/prisma/client';
import type { CardTopUp, User } from '../generated/prisma/client';
import { CardTopUpStatus } from '../generated/prisma/enums';
import { PaymentsService, REVIEW_PREFIX } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { CardTopUpNotReviewableError } from './admin.errors';
import type { AdminActor } from './admin.guard';
import { writeAudit } from './audit';

const LIST_LIMIT = 100;

/**
 * Parasi cekilmis olabilir ama bakiyeye yazilmamis kart odemeleri (guvenlik incelemesi
 * 2026-09-29 #3). Admin Iyzico panelinden kontrol edip karta iade eder; iade, kapali hesaba
 * gelen odemeyle ayni yoldan (REVERSAL_PENDING, mutabakat yeniden dener) gider.
 */
export class CardReviewService {
  constructor(
    private readonly prisma: PrismaService | PrismaClient,
    private readonly payments: PaymentsService,
  ) {}

  /** Incelemede bekleyenler ve iadesi suren (REVERSAL_PENDING) inceleme kayitlari. */
  async list(): Promise<AdminCardTopUpReview[]> {
    const rows = await this.prisma.cardTopUp.findMany({
      where: {
        failureReason: { startsWith: REVIEW_PREFIX },
        status: { in: [CardTopUpStatus.FAILED, CardTopUpStatus.REVERSAL_PENDING] },
      },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });
    return rows.map(toView);
  }

  async reverse(actor: AdminActor, topUpId: string, reason: string): Promise<AdminCardTopUpReview> {
    const done = await this.payments.reverseReviewed(topUpId, (tx, topUp) =>
      writeAudit(tx, {
        actorId: actor.userId,
        action: 'CARD_TOPUP_REVIEW_REVERSED',
        targetType: 'CARD_TOPUP',
        targetId: topUp.id,
        reason,
        details: {
          userId: topUp.userId,
          amountKurus: topUp.amountKurus,
          iyzicoPaymentId: topUp.iyzicoPaymentId,
          failureReason: topUp.failureReason,
        },
      }),
    );
    if (!done) throw new CardTopUpNotReviewableError();
    const row = await this.prisma.cardTopUp.findUniqueOrThrow({
      where: { id: done.id },
      include: { user: true },
    });
    return toView(row);
  }
}

function toView(t: CardTopUp & { user: User }): AdminCardTopUpReview {
  return {
    id: t.id,
    userId: t.userId,
    userEmail: t.user.email,
    amountKurus: t.amountKurus,
    status: t.status,
    reason: (t.failureReason ?? '').slice(REVIEW_PREFIX.length),
    iyzicoPaymentId: t.iyzicoPaymentId,
    createdAt: t.createdAt.toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
  };
}
