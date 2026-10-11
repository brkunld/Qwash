-- Kasiyer (ADMIN) basina gunluk nakit yukleme limiti (guvenlik incelemesi 2026-09-29 #7).
-- Varsayilan 10.000 TL; SUPER_ADMIN'e uygulanmaz.
ALTER TABLE "TopUpSettings" ADD COLUMN "dailyCashLimitKurus" INTEGER NOT NULL DEFAULT 1000000;
