// Iyzico tutarlari ondalik TL olarak ister/dondurur; sistem icinde her sey kurustur (ADR-0004).

/** 5000 -> "50", 5050 -> "50.5", 5005 -> "50.05" */
export function kurusToPrice(kurus: number): string {
  if (!Number.isSafeInteger(kurus) || kurus < 0) throw new Error(`Gecersiz kurus: ${kurus}`);
  const lira = Math.floor(kurus / 100);
  const rest = kurus % 100;
  if (rest === 0) return String(lira);
  return `${lira}.${String(rest).padStart(2, '0')}`.replace(/0$/, '');
}

/** "50.5" | 50.5 | "50.50" -> 5050. Kurustan hassas deger reddedilir. */
export function priceToKurus(price: string | number): number {
  const text = typeof price === 'number' ? price.toFixed(8) : price.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`Gecersiz tutar: ${String(price)}`);
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (fraction.length > 2) throw new Error(`Kurustan hassas tutar: ${String(price)}`);
  return Number(match[1]) * 100 + Number(fraction.padEnd(2, '0'));
}

/** Imza hesabi icin Iyzico'nun istedigi bicim: sondaki sifirlar atilir ("50.00" -> "50"). */
export function signaturePrice(price: string | number): string {
  return kurusToPrice(priceToKurus(price));
}
