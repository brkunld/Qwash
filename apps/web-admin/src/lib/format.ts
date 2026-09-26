import { assertKurus, formatKurus } from '@qwash/contracts';

/** 12345 -> "123,45 ₺" (yalniz gosterim). */
export function tl(kurus: number): string {
  return formatKurus(assertKurus(kurus));
}

/** 90 -> "1,5 dk", 120 -> "2 dk", 45 -> "45 sn" */
export function durationLabel(sec: number): string {
  if (sec < 60) return `${sec} sn`;
  const min = sec / 60;
  return `${Number.isInteger(min) ? min : min.toLocaleString('tr-TR')} dk`;
}

/** Tarih + saat, Istanbul saati (kasa gunu ile ayni). */
export function dateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('tr-TR', {
    timeZone: 'Europe/Istanbul',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "3 dk önce" gibi; cihaz sessizligini okumak icin. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (sec < 60) return `${sec} sn önce`;
  if (sec < 3600) return `${Math.floor(sec / 60)} dk önce`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} sa önce`;
  return `${Math.floor(sec / 86400)} gün önce`;
}

/** Istanbul yerel gunu, YYYY-AA-GG (kasa raporu varsayilani). */
export function istanbulToday(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' });
}

/** Saniyelik kurus fiyattan okunur fiyat: 50 -> "0,50 ₺/sn (30,00 ₺/dk)". */
export function pricePerSecond(kurus: number): string {
  return `${tl(kurus)}/sn (${tl(kurus * 60)}/dk)`;
}

/** "12,50" veya "12.5" -> 1250 kurus; gecersizse null. Ondalik ayiraci virgul veya nokta. */
export function parseTl(input: string): number | null {
  const s = input.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const kurus = Math.round(Number(s) * 100);
  return Number.isSafeInteger(kurus) ? kurus : null;
}
