// Para her zaman integer kurus olarak tasinir (ADR-0004). Float TL asla hesaplamaya girmez.

/** Kurus cinsinden tutar. Isaretli tam sayidir; negatif deger iade/duzeltme hareketleri icindir. */
export type Kurus = number & { readonly __brand: 'Kurus' };

export function assertKurus(value: number): Kurus {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Kurus tam sayi olmali: ${value}`);
  }
  return value as Kurus;
}

/** Sure (saniye) x saniyelik birim fiyat (kurus) = tutar (kurus). */
export function costForDuration(durationSeconds: number, pricePerSecondKurus: number): Kurus {
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 0) {
    throw new RangeError(`Sure negatif olmayan tam sayi olmali: ${durationSeconds}`);
  }
  if (!Number.isSafeInteger(pricePerSecondKurus) || pricePerSecondKurus < 0) {
    throw new RangeError(`Birim fiyat negatif olmayan tam sayi olmali: ${pricePerSecondKurus}`);
  }
  return assertKurus(durationSeconds * pricePerSecondKurus);
}

/** Yalnizca gosterim icin: 12345 -> "123,45 ₺". Hesaplamada kullanilmaz. */
export function formatKurus(amount: Kurus, locale = 'tr-TR'): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const lira = Math.trunc(abs / 100);
  const kurus = abs % 100;
  const liraText = lira.toLocaleString(locale);
  return `${sign}${liraText},${kurus.toString().padStart(2, '0')} ₺`;
}
