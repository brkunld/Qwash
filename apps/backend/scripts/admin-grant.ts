// Bir kullaniciya admin rolu verir veya geri alir (ADR-0011 madde 1).
// API uzerinden kimse kendini yukseltemez; ilk SUPER_ADMIN bu betikle atanir.
//
//   pnpm --filter @qwash/backend admin:grant <e-posta> <USER|ADMIN|SUPER_ADMIN>
//
// Kullanici once PWA'dan kayit olmus ve e-postasini dogrulamis olmali.
// Degisiklik aninda etkilidir: AdminGuard rolu her istekte veritabanindan okur.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { UserRole, UserStatus } from '../src/generated/prisma/enums';
import { createPrismaClient } from '../src/prisma/prisma.service';

const rootEnv = resolve(__dirname, '../../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

async function main(): Promise<void> {
  const [email, roleArg] = process.argv.slice(2).filter((a) => a !== '--');
  const role = Object.values(UserRole).find((r) => r === roleArg);
  if (!email || !role) {
    console.error('Kullanim: admin:grant <e-posta> <USER|ADMIN|SUPER_ADMIN>');
    process.exit(2);
  }

  const prisma = createPrismaClient(process.env.DATABASE_URL!);
  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { email: email.toLowerCase() } });
      if (!user) throw new Error(`Kullanici yok: ${email}`);
      if (user.status !== UserStatus.ACTIVE) throw new Error('Hesap aktif degil.');
      if (role !== UserRole.USER && !user.emailVerifiedAt) {
        throw new Error('Admin yapilacak hesabin e-postasi dogrulanmis olmali.');
      }
      await tx.user.update({ where: { id: user.id }, data: { role } });
      await tx.adminAuditLog.create({
        data: {
          actorId: null,
          action: 'ROLE_GRANTED',
          targetType: 'USER',
          targetId: user.id,
          details: { from: user.role, to: role, via: 'admin:grant' },
        },
      });
      console.log(`${user.email}: ${user.role} -> ${role}`);
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
