import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import type { FirmwareUpdate } from '../generated/prisma/client';
import { BayClaimStatus, FirmwareUpdateStatus, SessionStatus } from '../generated/prisma/enums';
import {
  commandTopic,
  type OtaCommandPayload,
  type OtaStatusPayload,
  type ParsedTopic,
  type SetConfigCommandPayload,
} from '../iot/iot.contract';
import type { OutboxService } from '../outbox/outbox.service';
import type { Tx } from '../wallet/wallet.service';
import { BayNotFoundError, BayUnavailableError, SessionError } from './session.errors';
import type { SessionService } from './session.service';

export interface DeviceOpsSettings {
  /** Cihaz QR'inin olmasi gereken tabani (Orn: https://qwash.com.tr/b/). */
  qrBase: string;
  /** Cihazin firmware indirecegi API kok adresi (Orn: http://192.168.1.7:3001). */
  deviceApiUrl: string;
}

export interface DeviceOpsTimings {
  /** Indirme baglantisinin gecerlilik suresi. */
  downloadTokenMs: number;
  /** Bu surede bitmeyen guncelleme sonuclandirilir (surum bildirildiyse basarili, yoksa zaman asimi). */
  updateTimeoutMs: number;
}

export const DEFAULT_DEVICE_OPS_TIMINGS: DeviceOpsTimings = {
  downloadTokenMs: 15 * 60_000,
  updateTimeoutMs: 15 * 60_000,
};

/** Devam eden (bitmemis) guncelleme durumlari. */
const OPEN: FirmwareUpdateStatus[] = [
  FirmwareUpdateStatus.PENDING,
  FirmwareUpdateStatus.DOWNLOADING,
  FirmwareUpdateStatus.REBOOTING,
];

const ACTIVE_SESSION: SessionStatus[] = [
  SessionStatus.STARTING,
  SessionStatus.RUNNING,
  SessionStatus.RECONCILING,
];

export class FirmwareUpdateError extends SessionError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

/** SessionService'in cihaz mesajlarini iletirken cagirdigi kancalar. */
export interface DeviceOpsHooks {
  onDeviceStatus(
    topic: ParsedTopic,
    deviceId: string,
    status: string,
    qrBase: string | undefined,
  ): Promise<void>;
  onOtaStatus(deviceId: string, p: OtaStatusPayload): Promise<void>;
}

/**
 * Cihaza uzaktan mudahale (ADR-0013): ayar (QR taban adresi) ve imzali firmware guncellemesi.
 *
 * Ayar: cihaz baglaninca DEVICE_STATUS ile kendi QR adresini bildirir; istenenden farkliysa
 * SET_CONFIG gider. Alan adi degisince yalniz .env degisir, cihazlar kendiliginden duzelir.
 *
 * Guncelleme: operator imaji kendi bilgisayarinda imzalar (firmware:sign), yayinlar
 * (firmware:publish), bir perona gonderir (firmware:rollout). Cihaz imzayi gomulu acik
 * anahtarla dogrular; backend imzalayamaz, yalniz iletir. Indirme baglantisi tek cihaza ozel,
 * kisa omurlu bir anahtardir.
 */
export class DeviceOpsService implements DeviceOpsHooks {
  private readonly logger = new Logger(DeviceOpsService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessions: SessionService,
    private readonly outbox: OutboxService,
    private readonly settings: DeviceOpsSettings,
    private readonly clock: () => Date = () => new Date(),
    private readonly timings: DeviceOpsTimings = DEFAULT_DEVICE_OPS_TIMINGS,
  ) {
    sessions.attachDeviceOps(this);
  }

  // ---------------------------------------------------------------------------
  // Ayar
  // ---------------------------------------------------------------------------

  async onDeviceStatus(
    topic: ParsedTopic,
    deviceId: string,
    status: string,
    qrBase: string | undefined,
  ): Promise<void> {
    if (qrBase !== undefined) {
      await this.prisma.device.updateMany({ where: { deviceId }, data: { qrBase } });
    }
    // Eski firmware QR adresini bildirmez ve SET_CONFIG'i tanimaz: ona gonderilmez.
    if (status !== 'ONLINE' || qrBase === undefined || qrBase === this.settings.qrBase) return;
    const device = await this.prisma.device.findUnique({
      where: { deviceId },
      include: { bay: { include: { station: true } } },
    });
    const bay = device?.bay;
    if (!bay || bay.bayCode !== topic.bayCode || bay.station.code !== topic.stationCode) return;
    const payload: SetConfigCommandPayload = { type: 'SET_CONFIG', qrBase: this.settings.qrBase };
    await this.prisma.$transaction((tx) =>
      this.enqueue(tx, bay.station.code, bay.bayCode, deviceId, payload, 60_000),
    );
    this.logger.log(
      { deviceId, from: qrBase, to: this.settings.qrBase },
      'Cihaz QR adresi guncelleniyor',
    );
  }

  // ---------------------------------------------------------------------------
  // Firmware yayini ve guncelleme
  // ---------------------------------------------------------------------------

  /**
   * Bir perondaki cihaza surum gonderir. Seans veya ekran bagi varken, cihaz saglikli degilken
   * ya da baska bir guncelleme surerken reddedilir. Donen: guncelleme kaydi.
   */
  async startUpdate(bayCode: string, version: string): Promise<FirmwareUpdate> {
    const bay = await this.prisma.bay.findUnique({
      where: { bayCode },
      include: { station: true, device: true },
    });
    if (!bay) throw new BayNotFoundError(bayCode);
    if (!bay.device) throw new BayUnavailableError(bayCode, 'NO_DEVICE');
    const problem = this.sessions.bayProblem(bay);
    if (problem && problem !== 'MAINTENANCE') throw new BayUnavailableError(bayCode, problem);
    const release = await this.prisma.firmwareRelease.findUnique({ where: { version } });
    if (!release) {
      throw new FirmwareUpdateError('FIRMWARE_NOT_FOUND', `Yayinlanmis surum yok: ${version}`);
    }
    if (bay.device.firmwareVersion === version) {
      throw new FirmwareUpdateError('FIRMWARE_SAME_VERSION', `Cihaz zaten ${version}`);
    }

    const token = randomBytes(32).toString('base64url');
    const now = this.clock();
    const deviceId = bay.device.deviceId;
    const fromVersion = bay.device.firmwareVersion;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Bay" WHERE "id" = ${bay.id} FOR UPDATE`;
      const busy = await tx.washSession.count({
        where: { bayId: bay.id, status: { in: ACTIVE_SESSION } },
      });
      const claimed = await tx.bayClaim.count({
        where: { bayId: bay.id, status: BayClaimStatus.ACTIVE, expiresAt: { gt: now } },
      });
      if (busy > 0 || claimed > 0) {
        throw new FirmwareUpdateError(
          'BAY_IN_USE',
          `Peron kullanimda, guncelleme sonra: ${bayCode}`,
        );
      }
      const open = await tx.firmwareUpdate.count({
        where: { deviceId, status: { in: OPEN } },
      });
      if (open > 0) {
        throw new FirmwareUpdateError(
          'UPDATE_IN_PROGRESS',
          `Cihazda suren guncelleme var: ${deviceId}`,
        );
      }
      const update = await tx.firmwareUpdate.create({
        data: {
          deviceId,
          releaseId: release.id,
          fromVersion,
          tokenHash: sha256Hex(token),
          tokenExpiresAt: new Date(now.getTime() + this.timings.downloadTokenMs),
        },
      });
      const payload: OtaCommandPayload = {
        type: 'OTA',
        updateId: update.id,
        version: release.version,
        url: `${this.settings.deviceApiUrl.replace(/\/$/, '')}/api/v1/firmware/download/${token}`,
        sha256: release.sha256,
        sizeBytes: release.sizeBytes,
        signature: release.signature,
      };
      // Cihaz cevrimdisiyse komut 2 dk sonra gecersiz olur; guncelleme zaman asimiyla kapanir.
      await this.enqueue(tx, bay.station.code, bay.bayCode, deviceId, payload, 120_000);
      this.logger.log({ deviceId, fromVersion, version }, 'Firmware guncellemesi gonderildi');
      return update;
    });
  }

  /**
   * Indirme anahtarini dogrular. Gecerliyse guncelleme DOWNLOADING olur ve imaj dosyasinin adi
   * doner; degilse null (anahtar yok, suresi dolmus veya guncelleme bitmis).
   */
  async resolveDownload(token: string): Promise<{ fileName: string; sizeBytes: number } | null> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const update = await this.prisma.firmwareUpdate.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { release: true },
    });
    const now = this.clock();
    if (!update || update.tokenExpiresAt <= now) return null;
    if (
      update.status !== FirmwareUpdateStatus.PENDING &&
      update.status !== FirmwareUpdateStatus.DOWNLOADING
    ) {
      return null;
    }
    await this.prisma.firmwareUpdate.update({
      where: { id: update.id },
      data: { status: FirmwareUpdateStatus.DOWNLOADING, downloadedAt: now },
    });
    return { fileName: update.release.fileName, sizeBytes: update.release.sizeBytes };
  }

  async onOtaStatus(deviceId: string, p: OtaStatusPayload): Promise<void> {
    const update = await this.prisma.firmwareUpdate.findUnique({ where: { id: p.updateId } });
    if (!update || update.deviceId !== deviceId) {
      this.logger.warn({ deviceId, updateId: p.updateId }, 'Bilinmeyen guncelleme bildirimi');
      return;
    }
    if (!OPEN.includes(update.status)) return; // Bitmis guncelleme (tekrar gelen bildirim)
    const now = this.clock();
    const detail = p.detail?.slice(0, 120) ?? null;
    const status: FirmwareUpdateStatus = FirmwareUpdateStatus[p.status];
    const finished =
      status === FirmwareUpdateStatus.SUCCEEDED || status === FirmwareUpdateStatus.FAILED;
    await this.prisma.firmwareUpdate.update({
      where: { id: update.id },
      data: { status, detail, ...(finished ? { finishedAt: now } : {}) },
    });
    const log = { deviceId, updateId: update.id, status, detail };
    if (status === FirmwareUpdateStatus.FAILED)
      this.logger.warn(log, 'Firmware guncellemesi basarisiz');
    else this.logger.log(log, 'Firmware guncelleme durumu');
  }

  /** Suresi dolan guncellemeleri sonuclandirir. */
  async sweep(): Promise<number> {
    const cutoff = new Date(this.clock().getTime() - this.timings.updateTimeoutMs);
    const stale = await this.prisma.firmwareUpdate.findMany({
      where: { status: { in: OPEN }, createdAt: { lte: cutoff } },
      include: { release: true, device: true },
      take: 50,
    });
    for (const u of stale) {
      // Yeni surumle acilip bildirim kaybolduysa cihazin raporladigi surum kanittir.
      const reached = u.device.firmwareVersion === u.release.version;
      await this.prisma.firmwareUpdate.updateMany({
        where: { id: u.id, status: { in: OPEN } },
        data: {
          status: reached ? FirmwareUpdateStatus.SUCCEEDED : FirmwareUpdateStatus.FAILED,
          detail: reached ? 'VERSION_REPORTED' : `TIMEOUT (${u.status})`,
          finishedAt: this.clock(),
        },
      });
    }
    return stale.length;
  }

  private async enqueue(
    tx: Tx,
    stationCode: string,
    bayCode: string,
    deviceId: string,
    payload: SetConfigCommandPayload | OtaCommandPayload,
    ttlMs: number,
  ): Promise<void> {
    const now = this.clock();
    await this.outbox.enqueue(tx, {
      topic: commandTopic(stationCode, bayCode),
      envelope: {
        commandId: randomUUID(),
        sessionId: '',
        deviceId,
        timestamp: now.toISOString(),
        payload,
      },
      expiresAt: new Date(now.getTime() + ttlMs),
    });
  }
}

/** Varsayilan imaj klasoru: depo kokunde firmware-releases/ (src/session ve dist/session ayni derinlikte). */
export function defaultFirmwareDir(): string {
  return resolve(__dirname, '../../../../firmware-releases');
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
