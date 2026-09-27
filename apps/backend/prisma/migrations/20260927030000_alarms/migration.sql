-- Calisan alarm durumu (Faz 7 izleme).
CREATE TABLE "Alarm" (
    "key" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "firingSince" TIMESTAMP(3) NOT NULL,
    "lastNotifiedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Alarm_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "Alarm_resolvedAt_idx" ON "Alarm"("resolvedAt");
