import type { Prisma } from '../generated/prisma/client';
import type { Tx } from '../wallet/wallet.service';

// Admin denetim kaydi (ADR-0011 madde 2). Para hareket ettiren islemde ledger kaydiyla
// ayni transaction'da cagrilir; tablo trigger ile degistirilemez.

export type AuditAction =
  | 'CASH_TOPUP'
  | 'BALANCE_ADJUSTMENT'
  | 'REFUND_PAYOUT_SENT'
  | 'REFUND_PAYOUT_RESULT'
  | 'REFUND_PAYOUT_RESOLVED'
  | 'REFUND_COMPLETED'
  | 'REFUND_REJECTED'
  | 'TOPUP_SETTINGS_UPDATED'
  | 'ROLE_GRANTED'
  | 'BAY_MAINTENANCE_ON'
  | 'BAY_MAINTENANCE_OFF'
  | 'SESSION_ADMIN_STOP'
  | 'SESSION_REVIEWED'
  | 'PROGRAM_CREATED'
  | 'PROGRAM_UPDATED'
  | 'PROGRAM_DELETED'
  | 'BAY_PROGRAMS_SET';

export type AuditTarget =
  'USER' | 'REFUND_REQUEST' | 'TOPUP_SETTINGS' | 'BAY' | 'SESSION' | 'PROGRAM';

export interface AuditEntry {
  /** null: komut satiri betigi. */
  actorId: string | null;
  action: AuditAction;
  targetType: AuditTarget;
  targetId?: string | null;
  reason?: string | null;
  details?: Prisma.InputJsonValue;
}

export async function writeAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.adminAuditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      reason: entry.reason ?? null,
      details: entry.details,
    },
  });
}
