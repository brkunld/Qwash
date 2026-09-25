-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('STARTING', 'RUNNING', 'COMPLETED', 'FAILED', 'RECONCILING');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'EXPIRED');

-- CreateTable
CREATE TABLE "WashSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "bayId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "relayIndex" INTEGER NOT NULL,
    "pricePerSecondKurus" INTEGER NOT NULL,
    "plannedDurationSec" INTEGER NOT NULL,
    "holdId" TEXT NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'STARTING',
    "idempotencyKey" TEXT NOT NULL,
    "startCommandId" TEXT NOT NULL,
    "ackDeadlineAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "usedSeconds" INTEGER,
    "chargedKurus" BIGINT,
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WashSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionTransition" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "fromState" "SessionStatus",
    "toState" "SessionStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "deviceId" TEXT NOT NULL,
    "bayId" TEXT,
    "reportedStatus" TEXT NOT NULL,
    "firmwareVersion" TEXT,
    "resetReason" INTEGER,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("deviceId")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "expiresAt" TIMESTAMP(3),
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxMessage" (
    "messageId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxMessage_pkey" PRIMARY KEY ("messageId")
);

-- CreateIndex
CREATE UNIQUE INDEX "WashSession_holdId_key" ON "WashSession"("holdId");

-- CreateIndex
CREATE UNIQUE INDEX "WashSession_idempotencyKey_key" ON "WashSession"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "WashSession_startCommandId_key" ON "WashSession"("startCommandId");

-- CreateIndex
CREATE INDEX "WashSession_status_ackDeadlineAt_idx" ON "WashSession"("status", "ackDeadlineAt");

-- CreateIndex
CREATE INDEX "WashSession_userId_createdAt_idx" ON "WashSession"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SessionTransition_sessionId_createdAt_idx" ON "SessionTransition"("sessionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Device_bayId_key" ON "Device"("bayId");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_createdAt_idx" ON "OutboxEvent"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "WashSession" ADD CONSTRAINT "WashSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WashSession" ADD CONSTRAINT "WashSession_bayId_fkey" FOREIGN KEY ("bayId") REFERENCES "Bay"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WashSession" ADD CONSTRAINT "WashSession_programId_fkey" FOREIGN KEY ("programId") REFERENCES "WashProgram"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WashSession" ADD CONSTRAINT "WashSession_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES "WalletHold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionTransition" ADD CONSTRAINT "SessionTransition_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WashSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_bayId_fkey" FOREIGN KEY ("bayId") REFERENCES "Bay"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Elle eklenen kurallar (Prisma semasinda ifade edilemeyenler)
-- ---------------------------------------------------------------------------

-- Bir peronda ayni anda yalnizca bir aktif seans olabilir (eszamanli iki "baslat" yarisi).
CREATE UNIQUE INDEX "WashSession_one_active_per_bay"
  ON "WashSession" ("bayId")
  WHERE "status" IN ('STARTING', 'RUNNING', 'RECONCILING');

ALTER TABLE "WashSession" ADD CONSTRAINT "WashSession_relay_range" CHECK ("relayIndex" BETWEEN 1 AND 4);
ALTER TABLE "WashSession" ADD CONSTRAINT "WashSession_duration_positive" CHECK ("plannedDurationSec" > 0);
ALTER TABLE "WashSession" ADD CONSTRAINT "WashSession_price_nonnegative" CHECK ("pricePerSecondKurus" >= 0);
ALTER TABLE "WashSession" ADD CONSTRAINT "WashSession_used_within_plan"
  CHECK ("usedSeconds" IS NULL OR ("usedSeconds" >= 0 AND "usedSeconds" <= "plannedDurationSec"));
-- Tamamlanan seansin tahsilati ve kullanilan suresi mutlaka yazilir.
ALTER TABLE "WashSession" ADD CONSTRAINT "WashSession_completed_has_charge"
  CHECK ("status" <> 'COMPLETED' OR ("chargedKurus" IS NOT NULL AND "usedSeconds" IS NOT NULL AND "endedAt" IS NOT NULL));

-- Outbox yayincisinin bekleyen kayitlari hizla bulmasi icin.
CREATE INDEX "OutboxEvent_pending" ON "OutboxEvent" ("createdAt") WHERE "status" = 'PENDING';
