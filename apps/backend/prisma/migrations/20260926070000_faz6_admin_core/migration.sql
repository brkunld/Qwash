-- CreateEnum
CREATE TYPE "RefundPayoutStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "RefundRequest" ADD COLUMN     "rejectReason" TEXT,
ADD COLUMN     "resolvedBy" TEXT;

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "reason" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashTopUp" (
    "id" TEXT NOT NULL,
    "receiptNo" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "amountKurus" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashTopUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundPayout" (
    "id" TEXT NOT NULL,
    "refundRequestId" TEXT NOT NULL,
    "partIndex" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "amountKurus" INTEGER NOT NULL,
    "cardTopUpId" TEXT,
    "status" "RefundPayoutStatus" NOT NULL DEFAULT 'PENDING',
    "reference" TEXT,
    "failureReason" TEXT,
    "operatorId" TEXT,
    "stationId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RefundPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminAuditLog_targetType_targetId_idx" ON "AdminAuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AdminAuditLog_actorId_createdAt_idx" ON "AdminAuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CashTopUp_receiptNo_key" ON "CashTopUp"("receiptNo");

-- CreateIndex
CREATE UNIQUE INDEX "CashTopUp_idempotencyKey_key" ON "CashTopUp"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CashTopUp_stationId_createdAt_idx" ON "CashTopUp"("stationId", "createdAt");

-- CreateIndex
CREATE INDEX "RefundPayout_method_status_completedAt_idx" ON "RefundPayout"("method", "status", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefundPayout_refundRequestId_partIndex_key" ON "RefundPayout"("refundRequestId", "partIndex");

-- AddForeignKey
ALTER TABLE "CashTopUp" ADD CONSTRAINT "CashTopUp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashTopUp" ADD CONSTRAINT "CashTopUp_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundPayout" ADD CONSTRAINT "RefundPayout_refundRequestId_fkey" FOREIGN KEY ("refundRequestId") REFERENCES "RefundRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Denetim kaydi degistirilemez (ADR-0011 madde 2); ledger_entry_immutable ile ayni kural.
CREATE FUNCTION "admin_audit_log_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AdminAuditLog kayitlari degistirilemez veya silinemez (id=%)', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AdminAuditLog_no_update_delete"
  BEFORE UPDATE OR DELETE ON "AdminAuditLog"
  FOR EACH ROW EXECUTE FUNCTION "admin_audit_log_immutable"();

-- Tutarlar pozitif olmali.
ALTER TABLE "CashTopUp" ADD CONSTRAINT "CashTopUp_amount_positive" CHECK ("amountKurus" > 0);
ALTER TABLE "RefundPayout" ADD CONSTRAINT "RefundPayout_amount_positive" CHECK ("amountKurus" > 0);
