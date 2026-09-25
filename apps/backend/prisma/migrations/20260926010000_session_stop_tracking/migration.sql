-- AlterTable
ALTER TABLE "WashSession" ADD COLUMN     "lastStopSentAt" TIMESTAMP(3),
ADD COLUMN     "stopAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stopConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "stopReason" TEXT,
ADD COLUMN     "stopRequestedAt" TIMESTAMP(3);

-- Onay bekleyen STOP'lar (tarama yeniden gonderim icin bunlara bakar).
CREATE INDEX "WashSession_stop_unconfirmed" ON "WashSession" ("lastStopSentAt")
  WHERE "stopRequestedAt" IS NOT NULL AND "stopConfirmedAt" IS NULL;
