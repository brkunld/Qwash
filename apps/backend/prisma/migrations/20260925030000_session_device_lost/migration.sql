-- AlterTable
ALTER TABLE "WashSession" ADD COLUMN     "needsReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "provenUsedSec" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reconcilingAt" TIMESTAMP(3);


ALTER TABLE "WashSession" ADD CONSTRAINT "WashSession_proven_within_plan"
  CHECK ("provenUsedSec" >= 0 AND "provenUsedSec" <= "plannedDurationSec");
CREATE INDEX "WashSession_needs_review" ON "WashSession" ("createdAt") WHERE "needsReview";
