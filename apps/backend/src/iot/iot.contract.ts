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

export interface CommandEnvelope {
  commandId: string;
  sessionId: string;
  deviceId?: string;
  timestamp: string;
  expiresAt?: string;
  payload: StartCommandPayload | StopCommandPayload;
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

export const DeviceMessageSchema = z.object({
  ...envelopeBase,
  payload: z.discriminatedUnion('type', [
    StartedAckSchema,
    StoppedAckSchema,
    SessionEndedSchema,
    SessionRecoveredSchema,
    DeviceStatusSchema,
    HeartbeatSchema,
  ]),
});

export type DeviceMessage = z.infer<typeof DeviceMessageSchema>;
