import { z } from 'zod';

// Cihaz <-> backend MQTT sozlesmesi (docs/IOT.md). Firmware: firmware/qwash_bay.

export const MAX_SESSION_SEC = 3600; // firmware/qwash_bay/config.h ile ayni

export type DeviceTopicKind = 'ack' | 'events' | 'status' | 'heartbeat';

export interface ParsedTopic {
  stationCode: string;
  bayCode: string;
  kind: DeviceTopicKind;
}

const TOPIC_RE = /^qwash\/station\/([^/]+)\/bay\/([^/]+)\/(ack|events|status|heartbeat)$/;

export function parseDeviceTopic(topic: string): ParsedTopic | null {
  const m = TOPIC_RE.exec(topic);
  if (!m) return null;
  return { stationCode: m[1]!, bayCode: m[2]!, kind: m[3] as DeviceTopicKind };
}

export function commandTopic(stationCode: string, bayCode: string): string {
  return `qwash/station/${stationCode}/bay/${bayCode}/cmd`;
}

/** Backend'in dinledigi topic'ler. */
export const DEVICE_SUBSCRIPTIONS = [
  'qwash/station/+/bay/+/ack',
  'qwash/station/+/bay/+/events',
  'qwash/station/+/bay/+/status',
  'qwash/station/+/bay/+/heartbeat',
];

// ---- Backend -> cihaz komutlari ----

export interface StartCommandPayload {
  type: 'START';
  program: string;
  relayIndex: number;
  durationSec: number;
}

export interface StopCommandPayload {
  type: 'STOP';
  reason: 'USER_STOP' | 'ACK_TIMEOUT' | 'LATE_ACK' | 'ADMIN_OVERRIDE' | 'DRIFT';
}

/** Musteri adina peron ekraninda gosterilen paket (ASCII; ekran fontunda Turkce harf yok). */
export interface MenuProgram {
  code: string;
  label: string;
  pricePerSecondKurus: number;
}

/**
 * Peron ekranini musterinin hesabina bagli menuye alir. Cihaz saati senkron olmayabilir,
 * bu yuzden sure goreli verilir (timeoutSec); son karar backend'dedir.
 */
export interface ShowMenuCommandPayload {
  type: 'SHOW_MENU';
  claimId: string;
  timeoutSec: number;
  /** true: seans yeni bitti, "tekrar sec" ekrani (Burak: ~30 sn). */
  afterSession: boolean;
  /** Maskeli hesap etiketi (Orn: "BU***@GMAIL.COM"), musteri dogru hesap oldugunu gorsun. */
  holder: string;
  availableKurus: number;
  programs: MenuProgram[];
  durationsSec: number[];
}

export interface ShowQrCommandPayload {
  type: 'SHOW_QR';
  claimId: string;
}

export interface MenuErrorCommandPayload {
  type: 'MENU_ERROR';
  claimId: string;
  /** Ekranda gosterilecek kisa ASCII mesaj. */
  message: string;
}

/** Cihaz ayari (ADR-0013). Yalniz verilen alanlar degisir; cihaz NVS'e yazar ve durumunu yeniden bildirir. */
export interface SetConfigCommandPayload {
  type: 'SET_CONFIG';
  qrBase: string;
}

/**
 * Imzali firmware guncellemesi (ADR-0013). Cihaz seans/ekran bagi yokken kabul eder, imaji
 * url'den indirir, sha256 ve imzayi (gomulu acik anahtar) dogrular, sonra yeniden baslar.
 */
export interface OtaCommandPayload {
  type: 'OTA';
  updateId: string;
  version: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  signature: string;
}

export type ScreenCommandPayload =
  ShowMenuCommandPayload | ShowQrCommandPayload | MenuErrorCommandPayload;

export interface CommandEnvelope {
  commandId: string;
  sessionId: string;
  deviceId?: string;
  timestamp: string;
  expiresAt?: string;
  payload:
    | StartCommandPayload
    | StopCommandPayload
    | ScreenCommandPayload
    | SetConfigCommandPayload
    | OtaCommandPayload;
}

// ---- Cihaz -> backend olaylari ----

const envelopeBase = {
  eventId: z.string().min(1).optional(), // LWT mesajinda yok
  deviceId: z.string().min(1),
  stationId: z.string().optional(),
  bayId: z.string().optional(),
  timestamp: z.string().optional(), // Cihaz saati senkron degilse gonderilmez
};

export const StartedAckSchema = z.object({
  type: z.literal('STARTED_ACK'),
  commandId: z.string().min(1),
  sessionId: z.string(),
  status: z.enum(['SUCCESS', 'REJECTED', 'DUPLICATE']),
  reason: z.string().optional(),
  remainingSec: z.number().int().nonnegative().optional(),
});

export const StoppedAckSchema = z.object({
  type: z.literal('STOPPED_ACK'),
  commandId: z.string().min(1),
  sessionId: z.string(),
  status: z.enum(['SUCCESS', 'NOT_ACTIVE', 'DUPLICATE']),
  remainingSec: z.number().int().nonnegative().optional(),
});

export const SessionEndedSchema = z.object({
  type: z.literal('SESSION_ENDED'),
  sessionId: z.string().min(1),
  commandId: z.string().optional(),
  reason: z.string(),
  remainingSec: z.number().int().nonnegative(),
});

export const SessionRecoveredSchema = z.object({
  type: z.literal('SESSION_RECOVERED'),
  sessionId: z.string().optional(),
  detail: z.string().optional(),
  remainingSec: z.number().int().nonnegative().optional(),
});

export const DeviceStatusSchema = z.object({
  type: z.literal('DEVICE_STATUS'),
  status: z.string(),
  firmwareVersion: z.string().optional(),
  resetReason: z.number().int().optional(),
  // Firmware 0.7.0+: cihazin kullandigi QR taban adresi (SET_CONFIG karsilastirmasi).
  qrBase: z.string().max(200).optional(),
});

export const HeartbeatSchema = z.object({
  type: z.literal('HEARTBEAT'),
  firmwareVersion: z.string().optional(),
  sessionActive: z.boolean().optional(),
  // Seans surerken: kanitlanmis kullanim bunlardan hesaplanir (ADR-0010 #8).
  sessionId: z.string().optional(),
  remainingSec: z.number().int().nonnegative().optional(),
  // Device twin: seans surerken cekili role (firmware 0.5.0+).
  relayIndex: z.number().int().optional(),
});

// Dokunmatik ekran olaylari (events topic'i). Ekrandaki DURDUR ayri olay degildir: cihaz roleyi
// hemen kapatir ve SESSION_ENDED (reason SCREEN_STOP) ile kalan sureyi bildirir. Cihaz yalniz kendi peronunun topic'ine yazabilir
// (ACL); backend ayrica bagin o perona ait oldugunu dogrular.
export const MenuStartSchema = z.object({
  type: z.literal('MENU_START'),
  claimId: z.string().min(1).max(64),
  programCode: z.string().min(1).max(64),
  durationSec: z.number().int().positive(),
  /** Dokunus basina cihazin urettigi anahtar: tekrar eden mesaj ikinci seans acmaz. */
  requestId: z.string().min(1).max(64),
});

export const MenuExitSchema = z.object({
  type: z.literal('MENU_EXIT'),
  claimId: z.string().min(1).max(64),
});

export const OtaStatusSchema = z.object({
  type: z.literal('OTA_STATUS'),
  updateId: z.string().min(1).max(64),
  status: z.enum(['DOWNLOADING', 'REBOOTING', 'SUCCEEDED', 'FAILED']),
  detail: z.string().max(120).optional(),
});
export type OtaStatusPayload = z.infer<typeof OtaStatusSchema>;

export type MenuEventPayload = z.infer<typeof MenuStartSchema> | z.infer<typeof MenuExitSchema>;

export const DeviceMessageSchema = z.object({
  ...envelopeBase,
  payload: z.discriminatedUnion('type', [
    StartedAckSchema,
    StoppedAckSchema,
    SessionEndedSchema,
    SessionRecoveredSchema,
    DeviceStatusSchema,
    HeartbeatSchema,
    MenuStartSchema,
    MenuExitSchema,
    OtaStatusSchema,
  ]),
});

export type DeviceMessage = z.infer<typeof DeviceMessageSchema>;
