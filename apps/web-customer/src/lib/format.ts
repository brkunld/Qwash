import { assertKurus, formatKurus } from '@qwash/contracts';

/** 12345 -> "123,45 ₺" (yalniz gosterim). */
export function tl(kurus: number): string {
  return formatKurus(assertKurus(kurus));
}

/** 125 -> "2:05" */
export function clock(totalSec: number): string {
  const s = Math.max(0, Math.ceil(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 90 -> "1,5 dk", 120 -> "2 dk", 45 -> "45 sn" */
export function durationLabel(sec: number): string {
  if (sec < 60) return `${sec} sn`;
  const min = sec / 60;
  return `${Number.isInteger(min) ? min : min.toLocaleString('tr-TR')} dk`;
}
