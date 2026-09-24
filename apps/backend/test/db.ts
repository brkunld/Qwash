import { PrismaClient } from '../src/generated/prisma/client';
import { createPrismaClient } from '../src/prisma/prisma.service';

export function testPrisma(): PrismaClient {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL yok; globalSetup calismadi mi?');
  return createPrismaClient(url);
}

/** Tum tablolari bosaltir. TRUNCATE, ledger degistirilemezlik trigger'ini tetiklemez. */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE "LedgerEntry", "WalletHold", "Wallet", "User",
             "BayProgram", "WashProgram", "Bay", "Station"
    RESTART IDENTITY CASCADE`);
}
