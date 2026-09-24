// Durum enum'lari docs/DATABASE.md ve ADR-0007 ile birebir ayni tutulur.

export const BayStatus = {
  IDLE: 'IDLE',
  WAITING: 'WAITING',
  RUNNING: 'RUNNING',
  OFFLINE: 'OFFLINE',
  MAINTENANCE: 'MAINTENANCE',
  ERROR: 'ERROR',
} as const;
export type BayStatus = (typeof BayStatus)[keyof typeof BayStatus];

export const DeviceStatus = {
  OFFLINE: 'OFFLINE',
  ONLINE: 'ONLINE',
  BUSY: 'BUSY',
  ERROR: 'ERROR',
  MAINTENANCE: 'MAINTENANCE',
} as const;
export type DeviceStatus = (typeof DeviceStatus)[keyof typeof DeviceStatus];
