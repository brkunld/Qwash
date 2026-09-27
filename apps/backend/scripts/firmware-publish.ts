// Imzali firmware imajini yayinlar (ADR-0013): imzayi acik anahtarla dogrular, imajin icinde
// surum metni oldugunu kontrol eder, FIRMWARE_DIR'e kopyalar ve FirmwareRelease kaydi acar.
//
//   pnpm firmware:publish <imaj.bin> <surum>      (Orn: ... qwash_bay.ino.bin 0.7.0)
//
// Once imzala: pnpm firmware:sign <imaj.bin>  (<imaj.bin>.sig uretir). Ozel anahtar burada gerekmez.
// Acik anahtar: OTA_PUBLIC_KEY_PATH veya firmware/keys/ota_public.pem.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash, verify } from 'node:crypto';
import { resolve } from 'node:path';
import { createPrismaClient } from '../src/prisma/prisma.service';
import { defaultFirmwareDir } from '../src/session/device-ops.service';

const root = resolve(__dirname, '../../..');
const rootEnv = resolve(root, '.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

async function main(): Promise<void> {
  const [bin, version] = process.argv.slice(2).filter((a) => a !== '--');
  if (!bin || !version || !/^[0-9A-Za-z._-]{1,32}$/.test(version)) {
    console.error('Kullanim: firmware:publish <imaj.bin> <surum>');
    process.exit(2);
  }
  const data = readFileSync(bin);
  const sigPath = `${bin}.sig`;
  if (!existsSync(sigPath)) throw new Error(`Imza yok: ${sigPath} (once pnpm firmware:sign)`);
  const signature = readFileSync(sigPath, 'utf8').trim();
  const pubPath = process.env.OTA_PUBLIC_KEY_PATH || resolve(root, 'firmware/keys/ota_public.pem');
  const publicKey = readFileSync(pubPath, 'utf8');
  if (!verify('sha256', data, publicKey, Buffer.from(signature, 'base64'))) {
    throw new Error('IMZA GECERSIZ: imaj degismis ya da baska anahtarla imzalanmis. Yayinlanmadi.');
  }
  // FW_VERSION imajin icinde duz metin olarak bulunur; yanlis surum numarasiyla yayini onler.
  if (data.indexOf(Buffer.from(`${version}\0`)) < 0) {
    throw new Error(`Imajda "${version}" surum metni yok; config.h FW_VERSION ile ayni olmali.`);
  }

  const dir = process.env.FIRMWARE_DIR || defaultFirmwareDir();
  mkdirSync(dir, { recursive: true });
  const fileName = `qwash_bay-${version}.bin`;
  const prisma = createPrismaClient(process.env.DATABASE_URL!);
  try {
    if (await prisma.firmwareRelease.findUnique({ where: { version } })) {
      throw new Error(`Surum zaten yayinli: ${version} (yeni surum numarasi ver)`);
    }
    copyFileSync(bin, resolve(dir, fileName));
    const sha256 = createHash('sha256').update(data).digest('hex');
    await prisma.firmwareRelease.create({
      data: { version, sha256, sizeBytes: data.length, signature, fileName },
    });
    console.log(`Yayinlandi: ${version} (${data.length} bayt, sha256 ${sha256.slice(0, 16)}...)`);
    console.log(`Perona gondermek icin: pnpm firmware:rollout <PERON> ${version}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
