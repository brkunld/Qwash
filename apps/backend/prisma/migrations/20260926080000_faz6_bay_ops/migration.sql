-- AlterTable
ALTER TABLE "Bay" ADD COLUMN     "maintenanceAt" TIMESTAMP(3),
ADD COLUMN     "maintenanceBy" TEXT,
ADD COLUMN     "maintenanceReason" TEXT;

-- AlterTable
ALTER TABLE "WashSession" ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedBy" TEXT;

