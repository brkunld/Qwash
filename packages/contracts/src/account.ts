import { z } from 'zod';

// Hesap silme ve iade talebi sozlesmeleri (ROADMAP acik soru 4, KVKK m.7).

/** TR IBAN: "TR" + 24 hane, bosluklar atilir, mod-97 kontrolu yapilir. */
export const TrIbanSchema = z
  .string()
  .transform((v) => v.replace(/\s+/g, '').toUpperCase())
  .refine((v) => /^TR\d{24}$/.test(v) && ibanChecksumValid(v), {
    message: 'Gecerli bir TR IBAN girin.',
  });

export function ibanChecksumValid(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of code) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export const RefundMethodSchema = z.enum(['CARD', 'IBAN', 'CASH_AT_STATION']);
export type RefundMethod = z.infer<typeof RefundMethodSchema>;

export const RefundAllocationPartSchema = z.object({
  method: RefundMethodSchema,
  source: z.enum(['CARD_TOPUP', 'CASH_TOPUP', 'OTHER']),
  amountKurus: z.number().int(),
  cardTopUpId: z.string().nullable(),
  creditedAt: z.string(),
});
export type RefundAllocationPart = z.infer<typeof RefundAllocationPartSchema>;

export const DeletionPreviewSchema = z.object({
  availableKurus: z.number().int(),
  /** Silmeyi engelleyen durumlar: aktif seans/bloke, sonuclanmamis kart yuklemesi. */
  blockers: z.array(z.enum(['ACTIVE_HOLD', 'TOPUP_IN_PROGRESS'])),
  /** FIFO: kalan bakiye en yeni yuklemelere aittir. */
  allocation: z.array(RefundAllocationPartSchema),
  /** 365 gunu asmis kart kismi veya kaynagi kart/nakit olmayan kisim varsa IBAN sart. */
  ibanRequired: z.boolean(),
  /** Nakit kaynakli kisim: istasyonda kasadan veya IBAN'a. */
  hasCashPart: z.boolean(),
  holderName: z.string().nullable(),
});
export type DeletionPreview = z.infer<typeof DeletionPreviewSchema>;

export const DeleteAccountRequestSchema = z.object({
  /** Bakiye yoksa gerekmez. KEEP secenegi istemcide silmeyi iptal etmektir. */
  balanceChoice: z.enum(['FORFEIT', 'REFUND']).optional(),
  /** FORFEIT icin zorunlu onay: "X TL bakiyemden vazgeciyorum". */
  confirmForfeit: z.literal(true).optional(),
  /** REFUND'da IBAN gereken kisim varsa zorunlu; verilirse nakit kisim da IBAN'a gider. */
  iban: TrIbanSchema.optional(),
  /** Sifreli hesaplarda yeniden dogrulama. */
  password: z.string().min(1).max(72).optional(),
});
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequestSchema>;

export const DeleteAccountResponseSchema = z.object({
  refundRequestId: z.string().nullable(),
  forfeitedKurus: z.number().int(),
});
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponseSchema>;
