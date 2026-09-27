-- Cihaz uzaktan ayar (QR adresi) ve imzali firmware guncellemesi (ADR-0013).
ALTER TABLE "Device" ADD COLUMN "qrBase" TEXT;

CREATE TYPE "FirmwareUpdateStatus" AS ENUM ('PENDING', 'DOWNLOADING', 'REBOOTING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "FirmwareRelease" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "signature" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FirmwareRelease_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FirmwareRelease_version_key" ON "FirmwareRelease"("version");

CREATE TABLE "FirmwareUpdate" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "fromVersion" TEXT,
    "status" "FirmwareUpdateStatus" NOT NULL DEFAULT 'PENDING',
    "tokenHash" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "downloadedAt" TIMESTAMP(3),
    "detail" TEXT,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FirmwareUpdate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FirmwareUpdate_tokenHash_key" ON "FirmwareUpdate"("tokenHash");
CREATE INDEX "FirmwareUpdate_deviceId_status_idx" ON "FirmwareUpdate"("deviceId", "status");
CREATE INDEX "FirmwareUpdate_status_createdAt_idx" ON "FirmwareUpdate"("status", "createdAt");
ALTER TABLE "FirmwareUpdate" ADD CONSTRAINT "FirmwareUpdate_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("deviceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FirmwareUpdate" ADD CONSTRAINT "FirmwareUpdate_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "FirmwareRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Bir cihazda ayni anda tek suren guncelleme.
CREATE UNIQUE INDEX "FirmwareUpdate_one_open_per_device" ON "FirmwareUpdate"("deviceId") WHERE "status" IN ('PENDING', 'DOWNLOADING', 'REBOOTING');
