import { randomUUID } from 'node:crypto';
import type {
  DeleteAccountResponse,
  DeletionPreview,
  RefundAllocationPart,
} from '@qwash/contracts';
import { PrismaClient } from '../generated/prisma/client';
import type { User, Wallet } from '../generated/prisma/client';
import {
  CardTopUpStatus,
  LedgerSource,
  LedgerType,
  RefundReason,
  UserStatus,
} from '../generated/prisma/enums';
import { verifyPassword } from '../auth/auth.crypto';
import { InvalidCredentialsError, UnauthenticatedError } from '../auth/auth.errors';
import { RECHECK_EXPIRED_FOR_MS } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { Tx, WalletService } from '../wallet/wallet.service';
import {
  ActiveHoldError,
  BalanceDecisionRequiredError,
  ForfeitConfirmationRequiredError,
  HolderNameRequiredError,
  IbanRequiredError,
  PasswordRequiredError,
  TopUpInProgressError,
} from './account.errors';
import { allocateRefund, CreditForAllocation, needsIban } from './refund-allocation';

// Hesap silme (KVKK m.7 anonimlestirme) ve iade talebi (ROADMAP acik soru 4).
//
// Silme tek transaction'da, cuzdan satiri FOR UPDATE kilitliyken yapilir; boylece
// ayni anda seans baslatma/odeme sonuclanmasi bakiyeyi degistiremez.
// Wallet/Ledger/CardTopUp silinmez (TTK m.82, VUK m.253). Iade talebi, admin EFT'de
// karsilastirabilsin diye muhurlu adi, iletisim e-postasini, IBAN'i ve FIFO dagilimini
// anonimlestirmeden ONCE kendi kaydina kopyalar.

export const ANONYMIZED_NAME = 'Silinmis Kullanici';

export interface DeleteAccountInput {
  balanceChoice?: 'FORFEIT' | 'REFUND';
  confirmForfeit?: true;
  iban?: string;
  password?: string;
}

export class AccountService {
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaService | PrismaClient,
    private readonly wallets: WalletService,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async previewDeletion(userId: string): Promise<DeletionPreview> {
    const user = await this.activeUser(userId);
    const wallet = await this.prisma.wallet.findUniqueOrThrow({ where: { userId } });
    const available = Number(wallet.balanceKurus - wallet.holdKurus);
    const allocation =
      available > 0
        ? allocateRefund(await this.credits(this.prisma, wallet.id), available, this.now(), false)
        : [];
    return {
      availableKurus: available,
      blockers: [
        ...(wallet.holdKurus > 0n ? (['ACTIVE_HOLD'] as const) : []),
        ...((await this.hasTopUpInFlight(this.prisma, userId))
          ? (['TOPUP_IN_PROGRESS'] as const)
          : []),
      ],
      allocation,
      ibanRequired: needsIban(allocation),
      hasCashPart: allocation.some((p) => p.source === 'CASH_TOPUP'),
      holderName: user.fullName,
    };
  }

  async deleteAccount(userId: string, input: DeleteAccountInput): Promise<DeleteAccountResponse> {
    const user = await this.activeUser(userId);
    if (user.passwordHash) {
      if (!input.password) throw new PasswordRequiredError();
      if (!(await verifyPassword(input.password, user.passwordHash)))
        throw new InvalidCredentialsError();
    }

    return this.prisma.$transaction(async (tx) => {
      const wallet = await lockWallet(tx, userId);
      // Kilit altinda tekrar: ayni anda iki silme istegi yarismasin.
      const fresh = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (fresh.status !== UserStatus.ACTIVE) throw new UnauthenticatedError();
      if (wallet.holdKurus > 0n) throw new ActiveHoldError();
      if (await this.hasTopUpInFlight(tx, userId)) throw new TopUpInProgressError();

      const available = Number(wallet.balanceKurus - wallet.holdKurus);
      let refundRequestId: string | null = null;
      let forfeitedKurus = 0;

      if (available > 0) {
        if (input.balanceChoice === 'FORFEIT') {
          if (input.confirmForfeit !== true) throw new ForfeitConfirmationRequiredError();
          await this.wallets.debitTx(tx, {
            walletId: wallet.id,
            amountKurus: available,
            source: LedgerSource.FORFEIT,
            idempotencyKey: `forfeit:${userId}`,
            referenceId: userId,
            note: 'Hesap silmede musterinin onayiyla bakiyeden feragat',
          });
          forfeitedKurus = available;
        } else if (input.balanceChoice === 'REFUND') {
          refundRequestId = await this.createRefundRequest(
            tx,
            fresh,
            wallet,
            available,
            input.iban ?? null,
          );
        } else {
          throw new BalanceDecisionRequiredError();
        }
      }

      await this.anonymize(tx, userId);
      return { refundRequestId, forfeitedKurus };
    });
  }

  private async createRefundRequest(
    tx: Tx,
    user: User,
    wallet: Wallet,
    amountKurus: number,
    iban: string | null,
  ): Promise<string> {
    const allocation = allocateRefund(
      await this.credits(tx, wallet.id),
      amountKurus,
      this.now(),
      iban !== null,
    );
    if (needsIban(allocation) && !iban) throw new IbanRequiredError();
    if (needsIban(allocation) && !user.fullName?.trim()) throw new HolderNameRequiredError();

    const id = randomUUID();
    const { hold } = await this.wallets.holdTx(tx, {
      walletId: wallet.id,
      amountKurus,
      source: LedgerSource.REFUND,
      idempotencyKey: `refund-request:${id}`,
      referenceId: id,
    });
    await tx.refundRequest.create({
      data: {
        id,
        userId: user.id,
        walletId: wallet.id,
        holdId: hold.id,
        reason: RefundReason.ACCOUNT_DELETION,
        amountKurus,
        holderName: user.fullName?.trim() ?? '',
        contactEmail: user.email,
        iban: needsIban(allocation) ? iban : null,
        allocation: allocation satisfies RefundAllocationPart[],
      },
    });
    return id;
  }

  private async anonymize(tx: Tx, userId: string): Promise<void> {
    const now = this.now();
    await tx.authIdentity.deleteMany({ where: { userId } });
    await tx.authToken.deleteMany({ where: { userId } });
    await tx.refreshToken.deleteMany({ where: { userId } });
    await tx.user.update({
      where: { id: userId },
      data: {
        status: UserStatus.DELETED,
        deletedAt: now,
        email: `deleted_${userId}@anonymized.local`,
        fullName: ANONYMIZED_NAME,
        phoneNumber: null,
        passwordHash: null,
        emailVerifiedAt: null,
        nameLockedAt: null,
      },
    });
  }

  private async credits(
    db: Tx | PrismaService | PrismaClient,
    walletId: string,
  ): Promise<CreditForAllocation[]> {
    const entries = await db.ledgerEntry.findMany({ where: { walletId, type: LedgerType.CREDIT } });
    const cardIds = entries
      .filter((e) => e.source === LedgerSource.CARD_TOPUP && e.referenceId)
      .map((e) => e.referenceId!);
    const topUps = new Map(
      (await db.cardTopUp.findMany({ where: { id: { in: cardIds } } })).map((t) => [t.id, t]),
    );
    return entries.map((e) => {
      const topUp = e.referenceId ? topUps.get(e.referenceId) : undefined;
      if (e.source === LedgerSource.CARD_TOPUP && topUp) {
        return {
          source: 'CARD_TOPUP',
          amountKurus: Number(e.amountKurus),
          // Iyzico'nun 365 gunu odeme tarihinden sayilir.
          creditedAt: topUp.completedAt ?? e.createdAt,
          cardTopUpId: topUp.id,
          alreadyRefundedKurus: topUp.refundedKurus,
        };
      }
      return {
        source: e.source === LedgerSource.CASH_TOPUP ? 'CASH_TOPUP' : 'OTHER',
        amountKurus: Number(e.amountKurus),
        creditedAt: e.createdAt,
        cardTopUpId: null,
        alreadyRefundedKurus: 0,
      };
    });
  }

  /** Sonuclanmamis veya gec basari gelebilecek kart yuklemesi var mi? */
  private async hasTopUpInFlight(
    db: Tx | PrismaService | PrismaClient,
    userId: string,
  ): Promise<boolean> {
    const count = await db.cardTopUp.count({
      where: {
        userId,
        OR: [
          { status: CardTopUpStatus.PENDING },
          {
            status: CardTopUpStatus.EXPIRED,
            createdAt: { gt: new Date(this.now().getTime() - RECHECK_EXPIRED_FOR_MS) },
          },
        ],
      },
    });
    return count > 0;
  }

  private async activeUser(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== UserStatus.ACTIVE) throw new UnauthenticatedError();
    return user;
  }
}

async function lockWallet(tx: Tx, userId: string): Promise<Wallet> {
  await tx.$queryRaw`SELECT "id" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
  return tx.wallet.findUniqueOrThrow({ where: { userId } });
}
