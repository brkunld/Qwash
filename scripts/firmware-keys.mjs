// Firmware imza anahtari (ECDSA P-256, ADR-0013).
//   firmware/keys/ota_private.pem   OZEL anahtar: yalniz imzalayan bilgisayarda. YEDEKLE, paylasma, sunucuya koyma.
//   firmware/keys/ota_public.pem    acik anahtar: backend yayinlarken imzayi dogrular
//   firmware/qwash_bay/ota_pubkey.h acik anahtar firmware'e gomulu (cihaz yalniz bununla imzalanmis imaji kabul eder)
// Kullanim: pnpm firmware:keys          (anahtar varsa korunur, yalniz ota_pubkey.h yeniden yazilir)
//           pnpm firmware:keys --new    (YENI anahtar: sahadaki cihazlar eski anahtarla gelen imaji artik kabul
//                                        etmez; once yeni anahtarli firmware'i USB'den yuklemek gerekir)
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve('firmware/keys');
const privPath = resolve(dir, 'ota_private.pem');
const pubPath = resolve(dir, 'ota_public.pem');
const header = resolve('firmware/qwash_bay/ota_pubkey.h');

if (!existsSync(privPath) || process.argv.includes('--new')) {
  mkdirSync(dir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(
    `Yeni imza anahtari: ${privPath}\nBu dosyayi guvenli bir yere YEDEKLE; kaybolursa sahadaki cihazlar uzaktan guncellenemez.`,
  );
} else {
  console.log(`Mevcut anahtar korundu: ${privPath}`);
}

const pem = readFileSync(pubPath, 'utf8').trim();
const lines = pem
  .split(/\r?\n/)
  .map((l) => `    "${l}\\n"`)
  .join('\n');
writeFileSync(
  header,
  `// pnpm firmware:keys ile uretilir (git disi). Cihaz yalniz bu acik anahtarla imzalanmis imaji kabul eder.
#pragma once
static const char OTA_PUBLIC_KEY_PEM[] =
${lines};
`,
);
console.log(`Firmware'e gomulecek acik anahtar yazildi: ${header}`);
