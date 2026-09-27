-- Bakim modu -> hizmet disi (ADR-0014): MAINTENANCE ve CLOSED turleri, musteri notu, cihaz revizyonu.
CREATE TYPE "OutOfServiceKind" AS ENUM ('MAINTENANCE', 'CLOSED');

ALTER TABLE "Bay" RENAME COLUMN "maintenanceAt" TO "outOfServiceAt";
ALTER TABLE "Bay" RENAME COLUMN "maintenanceReason" TO "outOfServiceReason";
ALTER TABLE "Bay" RENAME COLUMN "maintenanceBy" TO "outOfServiceBy";

ALTER TABLE "Bay" ADD COLUMN "outOfServiceKind" "OutOfServiceKind",
ADD COLUMN "outOfServiceNote" TEXT,
ADD COLUMN "availabilityRev" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Device" ADD COLUMN "availRev" INTEGER;

-- Mevcut bakim kayitlari MAINTENANCE turunu alir.
UPDATE "Bay" SET "outOfServiceKind" = 'MAINTENANCE' WHERE "outOfServiceAt" IS NOT NULL;
