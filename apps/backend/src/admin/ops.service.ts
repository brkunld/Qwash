import { Injectable } from '@nestjs/common';
import type {
  AdminBayView,
  AdminSessionView,
  ServiceRefundRequest,
  SetBayAvailabilityRequest,
  SetStationAvailabilityRequest,
  StationAvailabilityResult,
} from '@qwash/contracts';
import { PrismaClient } from '../generated/prisma/client';
import type { Bay, LedgerEntry, Prisma } from '../generated/prisma/client';
import { LedgerSource, SessionStatus, UserStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { DeviceOpsService } from '../session/device-ops.service';
import { SessionNotFoundError } from '../session/session.errors';
import { SessionService } from '../session/session.service';
import { type Tx, WalletService } from '../wallet/wallet.service';
import { AdminError, TargetAccountNotActiveError } from './admin.errors';
import type { AdminActor } from './admin.guard';
import { isUniqueViolation, lockUserWallet } from './admin.service';
import { writeAudit } from './audit';

/** Seans basina tek iade: ayni anahtar ledger'da unique oldugu icin ikinci kredi yazilamaz. */
const serviceRefundKey = (sessionId: string) => `service-refund:${sessionId}`;

const ACTIVE = [SessionStatus.STARTING, SessionStatus.RUNNING, SessionStatus.RECONCILING];

const AUDIT_ACTION = {
  OPEN: 'BAY_OPENED',
  MAINTENANCE: 'BAY_MAINTENANCE_ON',
  CLOSED: 'BAY_CLOSED',
} as const;

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
    private readonly deviceOps: Pick<DeviceOpsService, 'enqueueAvailability'>,
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
        outOfService:
          bay.outOfServiceKind && bay.outOfServiceAt
            ? {
                kind: bay.outOfServiceKind,
                since: bay.outOfServiceAt.toISOString(),
                reason: bay.outOfServiceReason,
                note: bay.outOfServiceNote,
                by: bay.outOfServiceBy,
              }
            : null,
        deviceInSync: !d || d.availRev === bay.availabilityRev,
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
   * Hizmet durumu (ADR-0014): bakim, kapali veya acik. Suren seans kesilmez (musteri odedigi
   * sureyi kullanir); yeni seans baslatilamaz. Durum ayni transaction'da cihaza da kuyruklanir.
   * Acil kesmek icin ayrica `stopSession`.
   */
  async setBayAvailability(
    actor: AdminActor,
    bayId: string,
    input: SetBayAvailabilityRequest,
  ): Promise<AdminBayView> {
    await this.prisma.$transaction(async (tx) => {
      const bay = await tx.bay.findUnique({ where: { id: bayId } });
      if (!bay) throw new AdminError('BAY_NOT_FOUND', 'Peron bulunamadi.');
      await this.applyAvailability(tx, bay, input, actor);
      await writeAudit(tx, {
        actorId: actor.userId,
        action: AUDIT_ACTION[input.state],
        targetType: 'BAY',
        targetId: bayId,
        reason: input.state === 'OPEN' ? null : input.reason,
        details: input.state === 'OPEN' ? undefined : { note: input.note ?? null },
      });
    });
    return (await this.bays()).find((b) => b.id === bayId)!;
  }

  /**
   * Istasyonun tum peronlari (gece kapatma vb.). CLOSED yalniz acik peronlara, OPEN yalniz
   * KAPALI peronlara uygulanir: bakimdaki peron bakimda kalir.
   */
  async setStationAvailability(
    actor: AdminActor,
    stationId: string,
    input: SetStationAvailabilityRequest,
  ): Promise<StationAvailabilityResult> {
    return this.prisma.$transaction(async (tx) => {
      const station = await tx.station.findUnique({
        where: { id: stationId },
        include: { bays: true },
      });
      if (!station) throw new AdminError('STATION_NOT_FOUND', 'Istasyon bulunamadi.');
      let changed = 0;
      let skippedMaintenance = 0;
      for (const bay of station.bays) {
        if (bay.outOfServiceKind === 'MAINTENANCE') {
          skippedMaintenance++;
          continue;
        }
        const target = input.state === 'CLOSED' ? 'CLOSED' : null;
        if (bay.outOfServiceKind === target) continue;
        await this.applyAvailability(tx, bay, input, actor);
        changed++;
      }
      await writeAudit(tx, {
        actorId: actor.userId,
        action: input.state === 'CLOSED' ? 'STATION_CLOSED' : 'STATION_OPENED',
        targetType: 'STATION',
        targetId: stationId,
        reason: input.state === 'CLOSED' ? input.reason : null,
        details: {
          changed,
          skippedMaintenance,
          ...(input.state === 'CLOSED' ? { note: input.note ?? null } : {}),
        },
      });
      return { changed, skippedMaintenance };
    });
  }

  private async applyAvailability(
    tx: Tx,
    bay: Bay,
    input: SetBayAvailabilityRequest,
    actor: AdminActor,
  ): Promise<void> {
    await tx.bay.update({
      where: { id: bay.id },
      data:
        input.state === 'OPEN'
          ? {
              outOfServiceKind: null,
              outOfServiceAt: null,
              outOfServiceReason: null,
              outOfServiceNote: null,
              outOfServiceBy: null,
              availabilityRev: { increment: 1 },
            }
          : {
              outOfServiceKind: input.state,
              // Ayni turde not/sebep degisirse baslangic zamani korunur.
              outOfServiceAt:
                bay.outOfServiceKind === input.state && bay.outOfServiceAt
                  ? bay.outOfServiceAt
                  : new Date(),
              outOfServiceReason: input.reason ?? null,
              outOfServiceNote: input.note ?? null,
              outOfServiceBy: actor.userId,
              availabilityRev: { increment: 1 },
            },
    });
    await this.deviceOps.enqueueAvailability(tx, bay.id);
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
