import { allocateRefund, CreditForAllocation, needsIban } from './refund-allocation';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-09-26T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY);

function card(amountKurus: number, ageDays: number, id: string, refunded = 0): CreditForAllocation {
  return {
    source: 'CARD_TOPUP',
    amountKurus,
    creditedAt: daysAgo(ageDays),
    cardTopUpId: id,
    alreadyRefundedKurus: refunded,
  };
}

function cash(amountKurus: number, ageDays: number): CreditForAllocation {
  return {
    source: 'CASH_TOPUP',
    amountKurus,
    creditedAt: daysAgo(ageDays),
    cardTopUpId: null,
    alreadyRefundedKurus: 0,
  };
}

describe('FIFO iade dagilimi', () => {
  it("Burak'in ornegi: 400 gun once 200 TL, 60 gun once 300 TL, 250 TL harcandi -> kalan 250 TL karta", () => {
    const parts = allocateRefund(
      [card(20000, 400, 'eski'), card(30000, 60, 'yeni')],
      25000,
      now,
      false,
    );
    expect(parts).toEqual([
      expect.objectContaining({ method: 'CARD', amountKurus: 25000, cardTopUpId: 'yeni' }),
    ]);
    expect(needsIban(parts)).toBe(false);
  });

  it('kalan bakiye 365 gunluk sinirdan eski yuklemeye tasarsa o kisim IBAN a gider', () => {
    const parts = allocateRefund(
      [card(20000, 400, 'eski'), card(30000, 60, 'yeni')],
      40000,
      now,
      false,
    );
    expect(parts).toEqual([
      expect.objectContaining({ method: 'CARD', amountKurus: 30000, cardTopUpId: 'yeni' }),
      expect.objectContaining({ method: 'IBAN', amountKurus: 10000, cardTopUpId: 'eski' }),
    ]);
    expect(needsIban(parts)).toBe(true);
  });

  it('350 gun pay sinirinda karta, sonrasinda IBAN a', () => {
    expect(allocateRefund([card(1000, 350, 'a')], 1000, now, false)[0]?.method).toBe('CARD');
    expect(allocateRefund([card(1000, 351, 'a')], 1000, now, false)[0]?.method).toBe('IBAN');
  });

  it('nakit kismi IBAN verilmediyse istasyonda, verildiyse IBAN a', () => {
    const credits = [cash(5000, 10), card(5000, 20, 'k')];
    expect(allocateRefund(credits, 8000, now, false)).toEqual([
      expect.objectContaining({
        method: 'CASH_AT_STATION',
        source: 'CASH_TOPUP',
        amountKurus: 5000,
      }),
      expect.objectContaining({ method: 'CARD', amountKurus: 3000 }),
    ]);
    expect(allocateRefund(credits, 8000, now, true)[0]?.method).toBe('IBAN');
  });

  it('daha once karta iade edilmis kisim tekrar dagitilmaz', () => {
    const parts = allocateRefund(
      [card(10000, 10, 'a', 4000), card(10000, 30, 'b')],
      9000,
      now,
      false,
    );
    expect(parts).toEqual([
      expect.objectContaining({ cardTopUpId: 'a', amountKurus: 6000 }),
      expect.objectContaining({ cardTopUpId: 'b', amountKurus: 3000 }),
    ]);
  });

  it('kaynagi aciklanamayan kalan IBAN olarak yazilir, tutar kaybolmaz', () => {
    const parts = allocateRefund([card(1000, 5, 'a')], 1500, now, false);
    expect(parts.reduce((s, p) => s + p.amountKurus, 0)).toBe(1500);
    expect(parts[1]).toMatchObject({ method: 'IBAN', source: 'OTHER', amountKurus: 500 });
  });
});
