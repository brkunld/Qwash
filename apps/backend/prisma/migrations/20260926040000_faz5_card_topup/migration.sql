-- CreateEnum
CREATE TYPE "CardTopUpStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "CardTopUp" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "amountKurus" INTEGER NOT NULL,
    "status" "CardTopUpStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "iyzicoToken" TEXT,
    "paymentPageUrl" TEXT,
    "iyzicoPaymentId" TEXT,
    "paymentTransactionId" TEXT,
    "refundedKurus" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CardTopUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopUpSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "minTopUpKurus" INTEGER NOT NULL DEFAULT 5000,
    "maxTopUpKurus" INTEGER NOT NULL DEFAULT 500000,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopUpSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CardTopUp_iyzicoToken_key" ON "CardTopUp"("iyzicoToken");

-- CreateIndex
CREATE INDEX "CardTopUp_status_createdAt_idx" ON "CardTopUp"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CardTopUp_userId_idempotencyKey_key" ON "CardTopUp"("userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "CardTopUp" ADD CONSTRAINT "CardTopUp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Tutarlar pozitif, iade yuklenen tutari asamaz.
ALTER TABLE "CardTopUp" ADD CONSTRAINT "CardTopUp_amount_positive" CHECK ("amountKurus" > 0);
ALTER TABLE "CardTopUp" ADD CONSTRAINT "CardTopUp_refund_range" CHECK ("refundedKurus" >= 0 AND "refundedKurus" <= "amountKurus");
ALTER TABLE "TopUpSettings" ADD CONSTRAINT "TopUpSettings_single_row" CHECK ("id" = 1);
ALTER TABLE "TopUpSettings" ADD CONSTRAINT "TopUpSettings_range" CHECK ("minTopUpKurus" > 0 AND "maxTopUpKurus" >= "minTopUpKurus");
INSERT INTO "TopUpSettings" ("id", "updatedAt") VALUES (1, now()) ON CONFLICT DO NOTHING;
