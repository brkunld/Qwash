import { z } from 'zod';
import { RefundMethodSchema } from './account.ts';

// Admin operasyonlari sozlesmeleri (Faz 6a, ADR-0011).

export const AdminRoleSchema = z.enum(['ADMIN', 'SUPER_ADMIN']);
export type AdminRole = z.infer<typeof AdminRoleSchema>;

/** GET /admin/me: admin panelinin rol kontrolu. */
export const AdminMeSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string().nullable(),
  role: AdminRoleSchema,
});
export type AdminMe = z.infer<typeof AdminMeSchema>;

const Kurus = z.number().int().positive();
/** Denetim kaydina girer; "duzeltme" gibi bos gerekceler kabul edilmez. */
const Reason = z.string().trim().min(10, 'Gerekce en az 10 karakter olmali.').max(500);

// ---------------------------------------------------------------------------
// Kullanici ve cuzdan arama
// ---------------------------------------------------------------------------

export const AdminUserSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string().nullable(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']),
  role: z.enum(['USER', 'ADMIN', 'SUPER_ADMIN']),
  emailVerified: z.boolean(),
  balanceKurus: z.number().int(),
  holdKurus: z.number().int(),
  createdAt: z.string(),
});
export type AdminUserSummary = z.infer<typeof AdminUserSummarySchema>;

export const AdminLedgerEntrySchema = z.object({
  id: z.string(),
  type: z.enum(['CREDIT', 'DEBIT', 'HOLD', 'CAPTURE', 'RELEASE']),
  source: z.string(),
  amountKurus: z.number().int(),
  balanceAfterKurus: z.number().int(),
  holdAfterKurus: z.number().int(),
  referenceId: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type AdminLedgerEntry = z.infer<typeof AdminLedgerEntrySchema>;

export const AdminUserDetailSchema = AdminUserSummarySchema.extend({
  phoneNumber: z.string().nullable(),
  nameLockedAt: z.string().nullable(),
  ledger: z.array(AdminLedgerEntrySchema),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;

// ---------------------------------------------------------------------------
// Nakit yukleme ve kasa raporu
// ---------------------------------------------------------------------------

export const CashTopUpRequestSchema = z.object({
  userId: z.uuid(),
  stationId: z.uuid(),
  amountKurus: Kurus,
});
export type CashTopUpRequest = z.infer<typeof CashTopUpRequestSchema>;

export const CashTopUpReceiptSchema = z.object({
  id: z.string(),
  receiptNo: z.number().int(),
  userId: z.string(),
  userEmail: z.string(),
  stationId: z.string(),
  amountKurus: z.number().int(),
  balanceAfterKurus: z.number().int(),
  operatorId: z.string(),
  createdAt: z.string(),
});
export type CashTopUpReceipt = z.infer<typeof CashTopUpReceiptSchema>;

export const CashReportQuerySchema = z.object({
  /** Istanbul yerel gunu, YYYY-AA-GG. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih YYYY-AA-GG olmali.'),
  stationId: z.uuid(),
});
export type CashReportQuery = z.infer<typeof CashReportQuerySchema>;

export const CashReportSchema = z.object({
  date: z.string(),
  stationId: z.string(),
  byOperator: z.array(
    z.object({
      operatorId: z.string(),
      operatorEmail: z.string().nullable(),
      topUpCount: z.number().int(),
      topUpKurus: z.number().int(),
      cashRefundCount: z.number().int(),
      cashRefundKurus: z.number().int(),
    }),
  ),
  totalTopUpKurus: z.number().int(),
  totalCashRefundKurus: z.number().int(),
  /** Kasada olmasi gereken nakit = giris - kasadan iade. */
  expectedCashKurus: z.number().int(),
});
export type CashReport = z.infer<typeof CashReportSchema>;

// ---------------------------------------------------------------------------
// Manuel bakiye duzeltme
// ---------------------------------------------------------------------------

export const BalanceAdjustmentRequestSchema = z.object({
  direction: z.enum(['CREDIT', 'DEBIT']),
  amountKurus: Kurus,
  reason: Reason,
});
export type BalanceAdjustmentRequest = z.infer<typeof BalanceAdjustmentRequestSchema>;

export const BalanceAdjustmentResultSchema = z.object({
  ledgerEntryId: z.string(),
  balanceAfterKurus: z.number().int(),
  holdAfterKurus: z.number().int(),
});
export type BalanceAdjustmentResult = z.infer<typeof BalanceAdjustmentResultSchema>;

// ---------------------------------------------------------------------------
// Iade talepleri
// ---------------------------------------------------------------------------

export const RefundPayoutStatusSchema = z.enum(['PENDING', 'IN_FLIGHT', 'DONE', 'FAILED']);
export type RefundPayoutStatus = z.infer<typeof RefundPayoutStatusSchema>;

export const RefundPayoutViewSchema = z.object({
  partIndex: z.number().int(),
  method: RefundMethodSchema,
  amountKurus: z.number().int(),
  cardTopUpId: z.string().nullable(),
  status: RefundPayoutStatusSchema,
  reference: z.string().nullable(),
  failureReason: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type RefundPayoutView = z.infer<typeof RefundPayoutViewSchema>;

export const AdminRefundRequestSchema = z.object({
  id: z.string(),
  userId: z.string(),
  reason: z.enum(['ACCOUNT_DELETION', 'SERVICE_FAILURE']),
  status: z.enum(['REQUESTED', 'COMPLETED', 'REJECTED']),
  amountKurus: z.number().int(),
  /** EFT'de bankanin gosterdigi alici adi bununla gozle karsilastirilir. */
  holderName: z.string(),
  contactEmail: z.string().nullable(),
  iban: z.string().nullable(),
  /** EFT aciklamasi: QWASH-REFUND-<USER_ID>. */
  transferDescription: z.string(),
  payouts: z.array(RefundPayoutViewSchema),
  rejectReason: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type AdminRefundRequest = z.infer<typeof AdminRefundRequestSchema>;

/**
 * IBAN/kasa parcasini "odendi" isaretlemek ya da IN_FLIGHT'ta kalmis kart parcasini
 * Iyzico panelinden kontrol ettikten sonra sonuclandirmak icin.
 */
export const ResolvePayoutRequestSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('PAID'),
    /** EFT dekont no, Iyzico iade kimligi veya kasa makbuz notu. */
    reference: z.string().trim().min(3).max(200),
    /** Kasadan odemede zorunlu (kasa raporu). */
    stationId: z.uuid().optional(),
  }),
  z.object({
    /** Yalniz IN_FLIGHT kart parcasi: Iyzico'da iade yok, yeniden denenebilir. */
    outcome: z.literal('NOT_PAID'),
    reason: Reason,
  }),
]);
export type ResolvePayoutRequest = z.infer<typeof ResolvePayoutRequestSchema>;

export const RejectRefundRequestSchema = z.object({ reason: Reason });
export type RejectRefundRequest = z.infer<typeof RejectRefundRequestSchema>;

// ---------------------------------------------------------------------------
// Yukleme ayarlari
// ---------------------------------------------------------------------------

export const TopUpSettingsViewSchema = z.object({
  minTopUpKurus: z.number().int(),
  maxTopUpKurus: z.number().int(),
  updatedAt: z.string(),
});
export type TopUpSettingsView = z.infer<typeof TopUpSettingsViewSchema>;

export const UpdateTopUpSettingsRequestSchema = z
  .object({
    minTopUpKurus: z.number().int().min(100),
    maxTopUpKurus: z.number().int().max(10_000_000),
  })
  .refine((v) => v.maxTopUpKurus >= v.minTopUpKurus, {
    message: 'Ust sinir minimumdan kucuk olamaz.',
    path: ['maxTopUpKurus'],
  });
export type UpdateTopUpSettingsRequest = z.infer<typeof UpdateTopUpSettingsRequestSchema>;

export const AdminStationSchema = z.object({ id: z.string(), code: z.string(), name: z.string() });
export type AdminStation = z.infer<typeof AdminStationSchema>;
