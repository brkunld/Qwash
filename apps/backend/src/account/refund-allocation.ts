import type { RefundAllocationPart } from '@qwash/contracts';

// FIFO iade dagilimi (ROADMAP acik soru 4, Burak 2026-09-26).
// Harcamalar en eski yuklemeden dusulmus sayilir; bu yuzden kalan bakiye, en yeni
// yuklemeden geriye dogru yuruyerek bulunur. Ek tablo gerekmez: her iade aninda
// ledger'daki CREDIT kayitlarindan yeniden hesaplanir.

/**
 * Iyzico karta iadeyi odemeden sonra en fazla 365 gun kabul eder. Talep admin
 * tarafindan sonra islenecegi icin 15 gun pay birakilir; bundan eski kart kismi IBAN'a gider.
 */
export const CARD_REFUND_WINDOW_MS = 350 * 24 * 60 * 60 * 1000;

export interface CreditForAllocation {
  source: 'CARD_TOPUP' | 'CASH_TOPUP' | 'OTHER';
  amountKurus: number;
  creditedAt: Date;
  /** Kart yuklemesi: Iyzico iade kimligi icin. */
  cardTopUpId: string | null;
  /** Bu yuklemeden daha once karta iade edilmis tutar. */
  alreadyRefundedKurus: number;
}

/**
 * @param credits Cuzdanin tum CREDIT kayitlari (sira onemli degil).
 * @param remainingKurus Iade edilecek kullanilabilir bakiye.
 * @param cashToIban Musteri IBAN verdiyse nakit kismi da IBAN'a gider; yoksa istasyonda kasadan.
 */
export function allocateRefund(
  credits: CreditForAllocation[],
  remainingKurus: number,
  now: Date,
  cashToIban: boolean,
): RefundAllocationPart[] {
  const newestFirst = [...credits].sort((a, b) => b.creditedAt.getTime() - a.creditedAt.getTime());
  const parts: RefundAllocationPart[] = [];
  let remaining = remainingKurus;

  for (const credit of newestFirst) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, credit.amountKurus - credit.alreadyRefundedKurus);
    if (take <= 0) continue;
    remaining -= take;
    parts.push({
      method: methodFor(credit, now, cashToIban),
      source: credit.source,
      amountKurus: take,
      cardTopUpId: credit.cardTopUpId,
      creditedAt: credit.creditedAt.toISOString(),
    });
  }

  // Ledger tutarliysa olmaz; yine de kalan kisim kaynaksiz birakilmaz, IBAN'a yazilir.
  if (remaining > 0) {
    parts.push({
      method: 'IBAN',
      source: 'OTHER',
      amountKurus: remaining,
      cardTopUpId: null,
      creditedAt: now.toISOString(),
    });
  }
  return parts;
}

function methodFor(
  credit: CreditForAllocation,
  now: Date,
  cashToIban: boolean,
): RefundAllocationPart['method'] {
  if (credit.source === 'CARD_TOPUP' && credit.cardTopUpId) {
    return now.getTime() - credit.creditedAt.getTime() <= CARD_REFUND_WINDOW_MS ? 'CARD' : 'IBAN';
  }
  if (credit.source === 'CASH_TOPUP') return cashToIban ? 'IBAN' : 'CASH_AT_STATION';
  return 'IBAN';
}

export function needsIban(parts: RefundAllocationPart[]): boolean {
  return parts.some((p) => p.method === 'IBAN');
}
