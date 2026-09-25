-- CreateEnum
CREATE TYPE "RefundReason" AS ENUM ('ACCOUNT_DELETION', 'SERVICE_FAILURE');

-- CreateEnum
CREATE TYPE "RefundRequestStatus" AS ENUM ('REQUESTED', 'COMPLETED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LedgerSource" ADD VALUE 'FORFEIT';
ALTER TYPE "LedgerSource" ADD VALUE 'CASH_REFUND';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "nameLockedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RefundRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "holdId" TEXT NOT NULL,
    "reason" "RefundReason" NOT NULL,
    "status" "RefundRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "amountKurus" INTEGER NOT NULL,
    "holderName" TEXT NOT NULL,
    "contactEmail" TEXT,
    "iban" TEXT,
    "allocation" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefundRequest_holdId_key" ON "RefundRequest"("holdId");

-- CreateIndex
CREATE INDEX "RefundRequest_status_createdAt_idx" ON "RefundRequest"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Iade talebi tutari pozitif.
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_amount_positive" CHECK ("amountKurus" > 0);
