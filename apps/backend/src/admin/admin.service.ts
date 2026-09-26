import { Injectable } from '@nestjs/common';
import type {
  AdminLedgerEntry,
  AdminMe,
  AdminStation,
  AdminUserDetail,
  AdminUserSummary,
  BalanceAdjustmentRequest,
  BalanceAdjustmentResult,
  CashReport,
  CashReportQuery,
  CashTopUpReceipt,
  CashTopUpRequest,
  TopUpSettingsView,
  UpdateTopUpSettingsRequest,
} from '@qwash/contracts';
import { Prisma, PrismaClient } from '../generated/prisma/client';
import type { CashTopUp, LedgerEntry, User, Wallet } from '../generated/prisma/client';
import { LedgerSource, LedgerType, UserStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { InsufficientFundsError } from '../wallet/wallet.errors';
import { Tx, WalletService } from '../wallet/wallet.service';
import {
  AdminError,
  AdminIdempotencyConflictError,
  AdminUserNotFoundError,
  CashAmountOutOfRangeError,
  StationNotFoundError,
  TargetAccountNotActiveError,
} from './admin.errors';
import type { AdminActor } from './admin.guard';
import { writeAudit } from './audit';

/** Turkiye 2016'dan beri sabit UTC+3 (yaz saati yok); kasa gunu Istanbul yerel gunudur. */
const ISTANBUL_OFFSET = '+03:00';
const DAY_MS = 24 * 60 * 60 * 1000;
const LEDGER_PAGE = 50;
const SEARCH_LIMIT = 20;

type UserWithWallet = User & { wallet: Wallet | null };

/**
 * Admin okuma ve para islemleri (ADR-0011): kullanici arama, nakit yukleme, kasa raporu,
 * manuel bakiye duzeltme, yukleme ayarlari. Iade isleme `RefundAdminService`'te.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService | PrismaClient,
    private readonly wallets: WalletService,
  ) {}

  async me(actor: AdminActor): Promise<AdminMe> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
    return { id: user.id, email: user.email, fullName: user.fullName, role: actor.role };
  }

  async stations(): Promise<AdminStation[]> {
    return this.prisma.station.findMany({
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    });
  }

  // -------------------------------------------------------------------------
  // Kullanici ve cuzdan arama
  // -------------------------------------------------------------------------

  async searchUsers(query: string): Promise<AdminUserSummary[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const users = await this.prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: q, mode: 'insensitive' } },
          { fullName: { contains: q, mode: 'insensitive' } },
          ...(isUuid(q) ? [{ id: q }] : []),
        ],
      },
      include: { wallet: true },
      orderBy: { createdAt: 'desc' },
      take: SEARCH_LIMIT,
    });
    return users.map(toSummary);
  }

  async userDetail(userId: string): Promise<AdminUserDetail> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { wallet: true },
    });
    if (!user) throw new AdminUserNotFoundError();
    const ledger = user.wallet
      ? await this.prisma.ledgerEntry.findMany({
          where: { walletId: user.wallet.id },
          orderBy: { createdAt: 'desc' },
          take: LEDGER_PAGE,
        })
      : [];
    return {
      ...toSummary(user),
      phoneNumber: user.phoneNumber,
      nameLockedAt: user.nameLockedAt?.toISOString() ?? null,
      ledger: ledger.map(toLedgerView),
    };
  }

  // -------------------------------------------------------------------------
  // Kasada nakit yukleme
  // -------------------------------------------------------------------------

  /**
   * Operatorun kasada aldigi nakdi musteri bakiyesine yukler. CashTopUp + CREDIT + denetim
   * kaydi tek transaction'da. Ayni Idempotency-Key tekrarinda ayni makbuz doner.
   */
  async cashTopUp(
    actor: AdminActor,
    input: CashTopUpRequest,
    idempotencyKey: string,
  ): Promise<CashTopUpReceipt> {
    const key = `cash-topup:${idempotencyKey}`;
    const replay = await this.findCashReplay(key, actor, input);
    if (replay) return replay;

    const settings = await this.topUpSettingsRow();
    if (input.amountKurus > settings.maxTopUpKurus) {
      throw new CashAmountOutOfRangeError(settings.maxTopUpKurus);
    }
    const station = await this.prisma.station.findUnique({ where: { id: input.stationId } });
    if (!station) throw new StationNotFoundError();

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Hesap silmeyle ayni cuzdan kilidi: silinmekte olan hesaba para yazilmaz.
        const { user, wallet } = await lockUserWallet(tx, input.userId);
        if (user.status !== UserStatus.ACTIVE) throw new TargetAccountNotActiveError();

        const topUp = await tx.cashTopUp.create({
          data: {
            userId: user.id,
            walletId: wallet.id,
            stationId: station.id,
            operatorId: actor.userId,
            amountKurus: input.amountKurus,
            idempotencyKey: key,
          },
        });
        const entry = await this.wallets.creditTx(tx, {
          walletId: wallet.id,
          amountKurus: input.amountKurus,
          source: LedgerSource.CASH_TOPUP,
          idempotencyKey: key,
          referenceId: topUp.id,
          note: `Kasada nakit yukleme, makbuz ${topUp.receiptNo}`,
        });
        await writeAudit(tx, {
          actorId: actor.userId,
          action: 'CASH_TOPUP',
          targetType: 'USER',
          targetId: user.id,
          details: {
            cashTopUpId: topUp.id,
            receiptNo: topUp.receiptNo,
            amountKurus: input.amountKurus,
            stationId: station.id,
          },
        });
        return toReceipt(topUp, user.email, entry);
      });
    } catch (error) {
      // Ayni anahtarla eszamanli iki istek: kaybeden geri alinir, kazananin makbuzu doner.
      if (isUniqueViolation(error)) {
        const winner = await this.findCashReplay(key, actor, input);
        if (winner) return winner;
      }
      throw error;
    }
  }

  private async findCashReplay(
    key: string,
    actor: AdminActor,
    input: CashTopUpRequest,
  ): Promise<CashTopUpReceipt | null> {
    const existing = await this.prisma.cashTopUp.findUnique({
      where: { idempotencyKey: key },
      include: { user: true },
    });
    if (!existing) return null;
    const same =
      existing.userId === input.userId &&
      existing.stationId === input.stationId &&
      existing.amountKurus === input.amountKurus &&
      existing.operatorId === actor.userId;
    if (!same) throw new AdminIdempotencyConflictError();
    const entry = await this.prisma.ledgerEntry.findUniqueOrThrow({
      where: { idempotencyKey: key },
    });
    return toReceipt(existing, existing.user.email, entry);
  }

  /** Istasyonun o gunku nakit girisi ve kasadan iadesi, operator bazinda. */
  async cashReport(query: CashReportQuery): Promise<CashReport> {
    const station = await this.prisma.station.findUnique({ where: { id: query.stationId } });
    if (!station) throw new StationNotFoundError();
    const from = new Date(`${query.date}T00:00:00${ISTANBUL_OFFSET}`);
    if (Number.isNaN(from.getTime())) throw new AdminError('INVALID_DATE', 'Tarih gecersiz.');
    const to = new Date(from.getTime() + DAY_MS);

    const [topUps, refunds] = await Promise.all([
      this.prisma.cashTopUp.groupBy({
        by: ['operatorId'],
        where: { stationId: station.id, createdAt: { gte: from, lt: to } },
        _sum: { amountKurus: true },
        _count: { _all: true },
      }),
      this.prisma.refundPayout.groupBy({
        by: ['operatorId'],
        where: {
          method: 'CASH_AT_STATION',
          status: 'DONE',
          stationId: station.id,
          completedAt: { gte: from, lt: to },
        },
        _sum: { amountKurus: true },
        _count: { _all: true },
      }),
    ]);

    const operatorIds = [
      ...new Set([...topUps, ...refunds].map((r) => r.operatorId).filter(isString)),
    ];
    const operators = await this.prisma.user.findMany({
      where: { id: { in: operatorIds } },
      select: { id: true, email: true },
    });
    const emailOf = new Map(operators.map((o) => [o.id, o.email]));

    const byOperator = operatorIds.sort().map((operatorId) => {
      const t = topUps.find((r) => r.operatorId === operatorId);
      const r = refunds.find((x) => x.operatorId === operatorId);
      return {
        operatorId,
        operatorEmail: emailOf.get(operatorId) ?? null,
        topUpCount: t?._count._all ?? 0,
        topUpKurus: t?._sum.amountKurus ?? 0,
        cashRefundCount: r?._count._all ?? 0,
        cashRefundKurus: r?._sum.amountKurus ?? 0,
      };
    });
    const totalTopUpKurus = byOperator.reduce((s, o) => s + o.topUpKurus, 0);
    const totalCashRefundKurus = byOperator.reduce((s, o) => s + o.cashRefundKurus, 0);
    return {
      date: query.date,
      stationId: station.id,
      byOperator,
      totalTopUpKurus,
      totalCashRefundKurus,
      expectedCashKurus: totalTopUpKurus - totalCashRefundKurus,
    };
  }

  // -------------------------------------------------------------------------
  // Manuel bakiye duzeltme
  // -------------------------------------------------------------------------

  /**
   * Yalniz hata duzeltmek icin (ROADMAP Faz 6). DEBIT bloke edilmis tutara dokunmaz.
   * Silinmis (anonimlestirilmis) hesapta yapilmaz; askidaki hesapta yapilabilir.
   */
  async adjustBalance(
    actor: AdminActor,
    userId: string,
    input: BalanceAdjustmentRequest,
    idempotencyKey: string,
  ): Promise<BalanceAdjustmentResult> {
    const key = `adjustment:${idempotencyKey}`;
    const type = input.direction === 'CREDIT' ? LedgerType.CREDIT : LedgerType.DEBIT;

    const replay = await this.findAdjustmentReplay(key, userId, type, input.amountKurus);
    if (replay) return replay;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const { user, wallet } = await lockUserWallet(tx, userId);
        if (user.status === UserStatus.DELETED) throw new TargetAccountNotActiveError();

        const credit = {
          walletId: wallet.id,
          amountKurus: input.amountKurus,
          source: LedgerSource.ADJUSTMENT,
          idempotencyKey: key,
          referenceId: actor.userId,
          note: input.reason,
        };
        let entry: LedgerEntry;
        try {
          entry =
            type === LedgerType.CREDIT
              ? await this.wallets.creditTx(tx, credit)
              : await this.wallets.debitTx(tx, credit);
        } catch (error) {
          if (error instanceof InsufficientFundsError) {
            throw new AdminError(
              'INSUFFICIENT_AVAILABLE',
              'Kullanilabilir bakiye yetersiz; bloke edilmis tutardan dusulemez.',
              { availableKurus: error.availableKurus },
            );
          }
          throw error;
        }
        await writeAudit(tx, {
          actorId: actor.userId,
          action: 'BALANCE_ADJUSTMENT',
          targetType: 'USER',
          targetId: user.id,
          reason: input.reason,
          details: {
            ledgerEntryId: entry.id,
            direction: input.direction,
            amountKurus: input.amountKurus,
          },
        });
        return toAdjustment(entry);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await this.findAdjustmentReplay(key, userId, type, input.amountKurus);
        if (winner) return winner;
      }
      throw error;
    }
  }

  private async findAdjustmentReplay(
    key: string,
    userId: string,
    type: LedgerType,
    amountKurus: number,
  ): Promise<BalanceAdjustmentResult | null> {
    const entry = await this.prisma.ledgerEntry.findUnique({
      where: { idempotencyKey: key },
      include: { wallet: { select: { userId: true } } },
    });
    if (!entry) return null;
    if (
      entry.wallet.userId !== userId ||
      entry.type !== type ||
      entry.amountKurus !== BigInt(amountKurus)
    ) {
      throw new AdminIdempotencyConflictError();
    }
    return toAdjustment(entry);
  }

  // -------------------------------------------------------------------------
  // Yukleme ayarlari
  // -------------------------------------------------------------------------

  async topUpSettings(): Promise<TopUpSettingsView> {
    const s = await this.topUpSettingsRow();
    return { ...s, updatedAt: s.updatedAt.toISOString() };
  }

  async updateTopUpSettings(
    actor: AdminActor,
    input: UpdateTopUpSettingsRequest,
  ): Promise<TopUpSettingsView> {
    return this.prisma.$transaction(async (tx) => {
      await tx.topUpSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
      const [before] = await tx.$queryRaw<{ minTopUpKurus: number; maxTopUpKurus: number }[]>`
        SELECT "minTopUpKurus", "maxTopUpKurus" FROM "TopUpSettings" WHERE "id" = 1 FOR UPDATE`;
      const after = await tx.topUpSettings.update({ where: { id: 1 }, data: input });
      await writeAudit(tx, {
        actorId: actor.userId,
        action: 'TOPUP_SETTINGS_UPDATED',
        targetType: 'TOPUP_SETTINGS',
        targetId: '1',
        details: { before: before!, after: input },
      });
      return {
        minTopUpKurus: after.minTopUpKurus,
        maxTopUpKurus: after.maxTopUpKurus,
        updatedAt: after.updatedAt.toISOString(),
      };
    });
  }

  private topUpSettingsRow() {
    return this.prisma.topUpSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  }
}

// ---------------------------------------------------------------------------

/** Kullaniciyi ve cuzdanini hesap silme / kart yuklemesiyle ayni kilitle alir. */
export async function lockUserWallet(
  tx: Tx,
  userId: string,
): Promise<{ user: User; wallet: Wallet }> {
  await tx.$queryRaw`SELECT "id" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id: userId }, include: { wallet: true } });
  if (!user?.wallet) throw new AdminUserNotFoundError();
  const { wallet, ...rest } = user;
  return { user: rest, wallet };
}

function toSummary(user: UserWithWallet): AdminUserSummary {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    role: user.role,
    emailVerified: user.emailVerifiedAt !== null,
    balanceKurus: Number(user.wallet?.balanceKurus ?? 0n),
    holdKurus: Number(user.wallet?.holdKurus ?? 0n),
    createdAt: user.createdAt.toISOString(),
  };
}

function toLedgerView(e: LedgerEntry): AdminLedgerEntry {
  return {
    id: e.id,
    type: e.type,
    source: e.source,
    amountKurus: Number(e.amountKurus),
    balanceAfterKurus: Number(e.balanceAfterKurus),
    holdAfterKurus: Number(e.holdAfterKurus),
    referenceId: e.referenceId,
    note: e.note,
    createdAt: e.createdAt.toISOString(),
  };
}

function toReceipt(topUp: CashTopUp, userEmail: string, entry: LedgerEntry): CashTopUpReceipt {
  return {
    id: topUp.id,
    receiptNo: topUp.receiptNo,
    userId: topUp.userId,
    userEmail,
    stationId: topUp.stationId,
    amountKurus: topUp.amountKurus,
    balanceAfterKurus: Number(entry.balanceAfterKurus),
    operatorId: topUp.operatorId,
    createdAt: topUp.createdAt.toISOString(),
  };
}

function toAdjustment(entry: LedgerEntry): BalanceAdjustmentResult {
  return {
    ledgerEntryId: entry.id,
    balanceAfterKurus: Number(entry.balanceAfterKurus),
    holdAfterKurus: Number(entry.holdAfterKurus),
  };
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function isString(v: string | null): v is string {
  return typeof v === 'string';
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
