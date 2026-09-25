-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('CREDIT', 'DEBIT', 'HOLD', 'CAPTURE', 'RELEASE');

-- CreateEnum
CREATE TYPE "LedgerSource" AS ENUM ('CARD_TOPUP', 'CASH_TOPUP', 'SESSION', 'ADJUSTMENT', 'REFUND');

-- CreateEnum
CREATE TYPE "HoldStatus" AS ENUM ('ACTIVE', 'CAPTURED', 'RELEASED');

-- CreateEnum
CREATE TYPE "BayStatus" AS ENUM ('IDLE', 'WAITING', 'RUNNING', 'OFFLINE', 'MAINTENANCE', 'ERROR');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "phoneNumber" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balanceKurus" BIGINT NOT NULL DEFAULT 0,
    "holdKurus" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" "LedgerType" NOT NULL,
    "source" "LedgerSource" NOT NULL,
    "amountKurus" BIGINT NOT NULL,
    "balanceAfterKurus" BIGINT NOT NULL,
    "holdAfterKurus" BIGINT NOT NULL,
    "holdId" TEXT,
    "referenceId" TEXT,
    "idempotencyKey" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletHold" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "amountKurus" BIGINT NOT NULL,
    "capturedKurus" BIGINT NOT NULL DEFAULT 0,
    "status" "HoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "LedgerSource" NOT NULL,
    "referenceId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "WalletHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Station" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Station_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bay" (
    "id" TEXT NOT NULL,
    "bayCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "BayStatus" NOT NULL DEFAULT 'IDLE',
    "stationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WashProgram" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "pricePerSecondKurus" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "WashProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BayProgram" (
    "id" TEXT NOT NULL,
    "bayId" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "relayIndex" INTEGER NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "BayProgram_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_idempotencyKey_key" ON "LedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerEntry_walletId_createdAt_idx" ON "LedgerEntry"("walletId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WalletHold_idempotencyKey_key" ON "WalletHold"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WalletHold_walletId_status_idx" ON "WalletHold"("walletId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Station_code_key" ON "Station"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Bay_bayCode_key" ON "Bay"("bayCode");

-- CreateIndex
CREATE UNIQUE INDEX "WashProgram_stationId_code_key" ON "WashProgram"("stationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "BayProgram_bayId_programId_key" ON "BayProgram"("bayId", "programId");

-- CreateIndex
CREATE UNIQUE INDEX "BayProgram_bayId_relayIndex_key" ON "BayProgram"("bayId", "relayIndex");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES "WalletHold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletHold" ADD CONSTRAINT "WalletHold_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bay" ADD CONSTRAINT "Bay_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WashProgram" ADD CONSTRAINT "WashProgram_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BayProgram" ADD CONSTRAINT "BayProgram_bayId_fkey" FOREIGN KEY ("bayId") REFERENCES "Bay"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BayProgram" ADD CONSTRAINT "BayProgram_programId_fkey" FOREIGN KEY ("programId") REFERENCES "WashProgram"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Elle eklenen veritabani kurallari (Prisma semasinda ifade edilemez).
-- Uygulama kodunda hata olsa bile para tutarliligi veritabaninda korunur (ADR-0004).
-- ---------------------------------------------------------------------------

-- Cuzdan: bloke negatif olamaz, bakiye blokeden kucuk olamaz (=> bakiye de negatif olamaz).
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_hold_nonnegative" CHECK ("holdKurus" >= 0);
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_balance_covers_hold" CHECK ("balanceKurus" >= "holdKurus");

-- Ledger: tutar her zaman pozitif; yon `type` ile belirlenir. Sonraki durumlar tutarli.
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_amount_positive" CHECK ("amountKurus" > 0);
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_after_consistent"
  CHECK ("holdAfterKurus" >= 0 AND "balanceAfterKurus" >= "holdAfterKurus");

-- Bloke: pozitif tutar, bloke edilenden fazla tahsil edilemez.
ALTER TABLE "WalletHold" ADD CONSTRAINT "WalletHold_amount_positive" CHECK ("amountKurus" > 0);
ALTER TABLE "WalletHold" ADD CONSTRAINT "WalletHold_captured_range"
  CHECK ("capturedKurus" >= 0 AND "capturedKurus" <= "amountKurus");
ALTER TABLE "WalletHold" ADD CONSTRAINT "WalletHold_settled_consistent"
  CHECK (("status" = 'ACTIVE') = ("settledAt" IS NULL));

-- Program fiyati negatif olamaz; role kanali 1..4.
ALTER TABLE "WashProgram" ADD CONSTRAINT "WashProgram_price_nonnegative" CHECK ("pricePerSecondKurus" >= 0);
ALTER TABLE "BayProgram" ADD CONSTRAINT "BayProgram_relay_range" CHECK ("relayIndex" BETWEEN 1 AND 4);

-- Ledger degistirilemez: UPDATE ve DELETE reddedilir. Duzeltme yeni kayitla yapilir.
-- Not: TRUNCATE bu trigger'i tetiklemez; production'da uygulama rolune TRUNCATE yetkisi
-- verilmez (Faz 7 guvenlik gozden gecirmesi).
CREATE FUNCTION "ledger_entry_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LedgerEntry kayitlari degistirilemez veya silinemez (id=%)', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerEntry_no_update_delete"
  BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entry_immutable"();
