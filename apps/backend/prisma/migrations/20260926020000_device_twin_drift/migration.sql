-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "driftConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "driftKind" TEXT,
ADD COLUMN     "driftSessionId" TEXT,
ADD COLUMN     "driftSince" TIMESTAMP(3),
ADD COLUMN     "lastDriftStopAt" TIMESTAMP(3);

-- Admin: kalici uyusmazligi olan cihazlar.
CREATE INDEX "Device_drift_confirmed" ON "Device" ("driftConfirmedAt") WHERE "driftConfirmedAt" IS NOT NULL;
