import { Injectable } from '@nestjs/common';
import type {
  AdminBayView,
  AdminSessionView,
  ServiceRefundRequest,
  SetMaintenanceRequest,
} from '@qwash/contracts';
import { PrismaClient } from '../generated/prisma/client';
import type { LedgerEntry, Prisma } from '../generated/prisma/client';
import { LedgerSource, SessionStatus, UserStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { SessionNotFoundError } from '../session/session.errors';
import { SessionService } from '../session/session.service';
import { WalletService } from '../wallet/wallet.service';
import { AdminError, TargetAccountNotActiveError } from './admin.errors';
import type { AdminActor } from './admin.guard';
import { isUniqueViolation, lockUserWallet } from './admin.service';
import { writeAudit } from './audit';

/** Seans basina tek iade: ayni anahtar ledger'da unique oldugu icin ikinci kredi yazilamaz. */
const serviceRefundKey = (sessionId: string) => `service-refund:${sessionId}`;

const ACTIVE = [SessionStatus.STARTING, SessionStatus.RUNNING, SessionStatus.RECONCILING];

const sessionInclude = {
  user: { select: { email: true } },
  bay: { select: { bayCode: true } },
  program: { select: { code: true } },
  transitions: {
    orderBy: { createdAt: 'asc' as const },
    select: { reason: true, createdAt: true },
  },
} satisfies Prisma.WashSessionInclude;

type SessionRow = Prisma.WashSessionGetPayload<{ include: typeof sessionInclude }>;

/** Peron ve seans operasyonlari (ADR-0011 #6, Faz 6b). */
@Injectable()
export class OpsService {
  constructor(
    private readonly prisma: PrismaService | PrismaClient,
    private readonly sessions: SessionService,
    private readonly wallets: WalletService,
  ) {}

  /** Dashboard: tum peronlar, cihaz sagligi, aktif seans, baslatilabilirlik. */
  async bays(): Promise<AdminBayView[]> {
    const bays = await this.prisma.bay.findMany({
      include: {
        station: { select: { code: true } },
        device: true,
        sessions: {
          where: { status: { in: ACTIVE } },
          include: { program: { select: { code: true } } },
          take: 1,
        },
      },
      orderBy: { bayCode: 'asc' },
    });
    return bays.map((bay) => {
      const s = bay.sessions[0];
      const d = bay.device;
      return {
        id: bay.id,
        bayCode: bay.bayCode,
        name: bay.name,
        stationCode: bay.station.code,
        status: bay.status,
        problem: this.sessions.bayProblem(bay),
        maintenance: bay.maintenanceAt
          ? {
              since: bay.maintenanceAt.toISOString(),
              reason: bay.maintenanceReason,
              by: bay.maintenanceBy,
            }
          : null,
        device: d
          ? {
              deviceId: d.deviceId,
              reportedStatus: d.reportedStatus,
              firmwareVersion: d.firmwareVersion,
              resetReason: d.resetReason,
              lastSeenAt: d.lastSeenAt.toISOString(),
              driftKind: d.driftKind,
              driftConfirmedAt: d.driftConfirmedAt?.toISOString() ?? null,
            }
          : null,
        activeSession: s
          ? {
              id: s.id,
              status: s.status,
              userId: s.userId,
              programCode: s.program.code,
              plannedDurationSec: s.plannedDurationSec,
              startedAt: s.startedAt?.toISOString() ?? null,
              stopRequestedAt: s.stopRequestedAt?.toISOString() ?? null,
            }
          : null,
      };
    });
  }

  /**
   * Bakim modu. Suren seans kesilmez (musteri odedigi sureyi kullanir); yeni seans
   * baslatilamaz. Acil kesmek icin ayrica `stopSession`.
   */
  async setMaintenance(
    actor: AdminActor,
    bayId: string,
    input: SetMaintenanceRequest,
  ): Promise<AdminBayView> {
    await this.prisma.$transaction(async (tx) => {
      const bay = await tx.bay.findUnique({ where: { id: bayId } });
      if (!bay) throw new AdminError('BAY_NOT_FOUND', 'Peron bulunamadi.');
      await tx.bay.update({
        where: { id: bayId },
        data: input.enabled
          ? {
              maintenanceAt: bay.maintenanceAt ?? new Date(),
              maintenanceReason: input.reason,
              maintenanceBy: actor.userId,
            }
          : { maintenanceAt: null, maintenanceReason: null, maintenanceBy: null },
      });
      await writeAudit(tx, {
        actorId: actor.userId,
        action: input.enabled ? 'BAY_MAINTENANCE_ON' : 'BAY_MAINTENANCE_OFF',
        targetType: 'BAY',
        targetId: bayId,
        reason: input.enabled ? input.reason : null,
      });
    });
    return (await this.bays()).find((b) => b.id === bayId)!;
  }

  /** Acil durdurma: cihaza STOP (ADMIN_OVERRIDE), tahsilat kullanilan saniye kadar. */
  async stopSession(
    actor: AdminActor,
    sessionId: string,
    reason: string,
  ): Promise<AdminSessionView> {
    const stopped = await this.sessions.adminStop(sessionId, (tx, s) =>
      writeAudit(tx, {
        actorId: actor.userId,
        action: 'SESSION_ADMIN_STOP',
        targetType: 'SESSION',
        targetId: s.id,
        reason,
        details: { status: s.status, bayId: s.bayId },
      }),
    );
    if (!stopped) {
      throw new AdminError('SESSION_NOT_ACTIVE', 'Seans aktif degil; durdurulacak bir sey yok.');
    }
    return this.session(sessionId);
  }

  /** needsReview seanslari. open=true: henuz incelenmemis olanlar. */
  async reviewQueue(open: boolean): Promise<AdminSessionView[]> {
    const rows = await this.prisma.washSession.findMany({
      where: { needsReview: true, ...(open ? { reviewedAt: null } : {}) },
      include: sessionInclude,
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return this.withRefunds(rows);
  }

  async session(sessionId: string): Promise<AdminSessionView> {
    const row = await this.prisma.washSession.findUnique({
      where: { id: sessionId },
      include: sessionInclude,
    });
    if (!row) throw new SessionNotFoundError(sessionId);
    return (await this.withRefunds([row]))[0]!;
  }

  /**
   * Teknik hata iadesi (Burak, 2026-09-26): seans ucreti karta degil cuzdana geri yazilir.
   * Seans basina en fazla bir kez; tutar tahsil edileni asamaz. Kredi, denetim kaydi ve
   * kontroller cuzdan kilidi altinda tek transaction'da.
   */
  async serviceRefund(
    actor: AdminActor,
    sessionId: string,
    input: ServiceRefundRequest,
  ): Promise<AdminSessionView> {
    const key = serviceRefundKey(sessionId);
    try {
      await this.prisma.$transaction(async (tx) => {
        const s = await tx.washSession.findUnique({ where: { id: sessionId } });
        if (!s) throw new SessionNotFoundError(sessionId);
        // Hesap silme / nakit yukleme ile ayni kilit; silinmekte olan hesaba para yazilmaz.
        const { user, wallet } = await lockUserWallet(tx, s.userId);
        if (user.status === UserStatus.DELETED) throw new TargetAccountNotActiveError();

        if (await tx.ledgerEntry.findUnique({ where: { idempotencyKey: key } })) {
          throw alreadyRefunded();
        }
        const charged = Number(s.chargedKurus ?? 0n);
        if (s.status !== SessionStatus.COMPLETED || charged <= 0) {
          throw new AdminError(
            'SESSION_NOT_REFUNDABLE',
            'Yalniz tamamlanmis ve ucret alinmis seans iade edilebilir.',
            { status: s.status, chargedKurus: charged },
          );
        }
        const amount = input.amountKurus ?? charged;
        if (amount > charged) {
          throw new AdminError('REFUND_EXCEEDS_CHARGE', 'Iade tutari tahsil edileni asamaz.', {
            chargedKurus: charged,
          });
        }

        const entry = await this.wallets.creditTx(tx, {
          walletId: wallet.id,
          amountKurus: amount,
          source: LedgerSource.SERVICE_REFUND,
          idempotencyKey: key,
          referenceId: sessionId,
          note: input.reason,
        });
        await writeAudit(tx, {
          actorId: actor.userId,
          action: 'SESSION_SERVICE_REFUND',
          targetType: 'SESSION',
          targetId: sessionId,
          reason: input.reason,
          details: { ledgerEntryId: entry.id, amountKurus: amount, chargedKurus: charged },
        });
      });
    } catch (error) {
      // Eszamanli iki istek: kaybeden unique ihlaliyle geri alinir.
      if (isUniqueViolation(error)) throw alreadyRefunded();
      throw error;
    }
    return this.session(sessionId);
  }

  private async withRefunds(rows: SessionRow[]): Promise<AdminSessionView[]> {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { idempotencyKey: { in: rows.map((r) => serviceRefundKey(r.id)) } },
    });
    const bySession = new Map(entries.map((e) => [e.referenceId, e]));
    return rows.map((r) => toSessionView(r, bySession.get(r.id)));
  }

  /**
   * Incelemeyi kapatir. Para hareket etmez; musteriye fark gerekiyorsa SUPER_ADMIN
   * bakiye duzeltmesiyle (gerekcede seans id) ayrica yapilir.
   */
  async markReviewed(
    actor: AdminActor,
    sessionId: string,
    note: string,
  ): Promise<AdminSessionView> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "WashSession" WHERE "id" = ${sessionId} FOR UPDATE`;
      const s = await tx.washSession.findUnique({ where: { id: sessionId } });
      if (!s) throw new SessionNotFoundError(sessionId);
      if (!s.needsReview) {
        throw new AdminError('SESSION_NOT_FLAGGED', 'Bu seans incelemeye isaretli degil.');
      }
      if (s.reviewedAt) throw new AdminError('ALREADY_REVIEWED', 'Seans zaten incelenmis.');
      await tx.washSession.update({
        where: { id: sessionId },
        data: { reviewedAt: new Date(), reviewedBy: actor.userId, reviewNote: note },
      });
      await writeAudit(tx, {
        actorId: actor.userId,
        action: 'SESSION_REVIEWED',
        targetType: 'SESSION',
        targetId: sessionId,
        reason: note,
      });
    });
    return this.session(sessionId);
  }
}

function alreadyRefunded(): AdminError {
  return new AdminError(
    'SESSION_ALREADY_REFUNDED',
    'Bu seans icin teknik hata iadesi zaten yapildi.',
  );
}

function toSessionView(s: SessionRow, refund?: LedgerEntry): AdminSessionView {
  return {
    id: s.id,
    userId: s.userId,
    userEmail: s.user.email,
    bayCode: s.bay.bayCode,
    programCode: s.program.code,
    status: s.status,
    plannedDurationSec: s.plannedDurationSec,
    usedSeconds: s.usedSeconds,
    provenUsedSec: s.provenUsedSec,
    chargedKurus: s.chargedKurus === null ? null : Number(s.chargedKurus),
    endReason: s.endReason,
    needsReview: s.needsReview,
    reviewedAt: s.reviewedAt?.toISOString() ?? null,
    reviewNote: s.reviewNote,
    transitions: s.transitions.map((t) => ({ reason: t.reason, at: t.createdAt.toISOString() })),
    createdAt: s.createdAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
    serviceRefund: refund
      ? {
          amountKurus: Number(refund.amountKurus),
          note: refund.note,
          at: refund.createdAt.toISOString(),
        }
      : null,
  };
}
