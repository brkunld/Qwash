-- Dokunmatik ekrandan seans: peron ekraninin musteri hesabina gecici bagi.
CREATE TYPE "BayClaimStatus" AS ENUM ('ACTIVE', 'RELEASED', 'EXPIRED');

CREATE TABLE "BayClaim" (
    "id" TEXT NOT NULL,
    "bayId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "BayClaimStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BayClaim_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BayClaim_bayId_status_idx" ON "BayClaim"("bayId", "status");
CREATE INDEX "BayClaim_status_expiresAt_idx" ON "BayClaim"("status", "expiresAt");

ALTER TABLE "BayClaim" ADD CONSTRAINT "BayClaim_bayId_fkey" FOREIGN KEY ("bayId") REFERENCES "Bay"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BayClaim" ADD CONSTRAINT "BayClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Bir peron ayni anda yalniz bir musteriye bagli olabilir (iki kisi ayni anda "bagla" derse biri kazanir).
CREATE UNIQUE INDEX "BayClaim_one_active_per_bay" ON "BayClaim"("bayId") WHERE "status" = 'ACTIVE';
