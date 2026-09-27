import { z } from 'zod';

// Peron (QR onayi) ve yikama seansi sozlesmeleri (Faz 5c, API.md "Peron & Seans").

/**
 * Peron neden su an baslatilamaz. null: kullanilabilir.
 * BUSY: peronda baska bir seans suruyor. CLAIMED: peron ekrani su an baska bir musteriye
 * bagli (dokunmatikten secim yapiyor). Digerleri cihaz/bakim durumudur.
 */
export const BayUnavailableReasonSchema = z.enum([
  'MAINTENANCE',
  'CLOSED',
  'NO_DEVICE',
  'DEVICE_OFFLINE',
  'DEVICE_STALE',
  'BUSY',
  'CLAIMED',
]);
export type BayUnavailableReason = z.infer<typeof BayUnavailableReasonSchema>;

export const BayProgramViewSchema = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  pricePerSecondKurus: z.number().int(),
});
export type BayProgramView = z.infer<typeof BayProgramViewSchema>;

/** QR okutulunca gosterilen "Peron X'e baglaniyorsunuz" onay ekraninin verisi. */
export const BayViewSchema = z.object({
  bayCode: z.string(),
  bayName: z.string(),
  stationName: z.string(),
  available: z.boolean(),
  unavailableReason: BayUnavailableReasonSchema.nullable(),
  /** Hizmet disiyken isletmenin musteriye notu (Orn: "15:00'te acilir"). */
  notice: z.string().nullable(),
  programs: z.array(BayProgramViewSchema),
  /** Tek seansin en uzun suresi (saniye). */
  maxDurationSec: z.number().int(),
});
export type BayView = z.infer<typeof BayViewSchema>;

/**
 * Dokunmatik ekrandan seans: peron ekrani kisa sure musterinin hesabina baglanir, paket ve
 * sure ekrandan secilir, para bu hesaptan cekilir. expiresAt'e kadar secim yapilmazsa (veya
 * seans bittikten sonra ~30 sn icinde yeni paket secilmezse) bag kopar, ekran QR'a doner.
 */
export const BayClaimViewSchema = z.object({
  claimId: z.string(),
  bayCode: z.string(),
  /** Bu anda seans yoksa bag sona erer. Seans surerken bag acik kalir. */
  expiresAt: z.string(),
  serverTime: z.string(),
});
export type BayClaimView = z.infer<typeof BayClaimViewSchema>;

export const StartSessionRequestSchema = z.object({
  bayCode: z.string().min(1).max(64),
  programCode: z.string().min(1).max(64),
  durationSec: z.number().int().positive(),
});
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>;

export const SessionStatusSchema = z.enum([
  'STARTING',
  'RUNNING',
  'RECONCILING',
  'COMPLETED',
  'FAILED',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * Musteriye gosterilen seans durumu. Geri sayim istemcide hesaplanir:
 * bitis = startedAt + plannedDurationSec. Sunucu saniyelik tick gondermez;
 * istemci saat farkini serverTime ile duzeltir.
 */
export const SessionViewSchema = z.object({
  sessionId: z.string(),
  status: SessionStatusSchema,
  bayCode: z.string(),
  bayName: z.string(),
  programCode: z.string(),
  programName: z.string(),
  pricePerSecondKurus: z.number().int(),
  plannedDurationSec: z.number().int(),
  /** Baslangicta bloke edilen tutar (plannedDurationSec * fiyat). */
  heldKurus: z.number().int(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  stopRequested: z.boolean(),
  usedSeconds: z.number().int().nullable(),
  chargedKurus: z.number().int().nullable(),
  endReason: z.string().nullable(),
  serverTime: z.string(),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

/** Socket.IO olay adlari. Baglanti: handshake auth.token = access token. */
export const SOCKET_EVENTS = {
  /** Sunucu -> istemci: kullanicinin bir seansi degisti (payload: SessionView). */
  SESSION_UPDATED: 'session.updated',
  /**
   * Sunucu -> istemci: sunucu bazi bildirimleri kacirmis olabilir; istemci
   * GET /sessions/active (veya izledigi seans icin GET /sessions/:id) ile tazelenir.
   */
  RESYNC: 'session.resync',
  /** Sunucu -> istemci: kimlik dogrulanamadi, baglanti kapatiliyor (payload: { code }). */
  AUTH_ERROR: 'auth.error',
} as const;
