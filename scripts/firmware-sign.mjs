// Firmware imajini imzalar (ADR-0013). Ozel anahtarin oldugu bilgisayarda calisir.
// Kullanim: pnpm firmware:sign <imaj.bin>   ->  <imaj.bin>.sig  (ECDSA P-256 / SHA-256, DER, base64)
// Imaj: Arduino IDE > Sketch > Export Compiled Binary (qwash_bay.ino.bin) veya arduino-cli --output-dir.
import { createHash, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const bin = process.argv[2];
if (!bin || !existsSync(bin)) {
  console.error('Kullanim: pnpm firmware:sign <imaj.bin>');
  process.exit(2);
}
const keyPath = resolve('firmware/keys/ota_private.pem');
if (!existsSync(keyPath)) {
  console.error('Ozel anahtar yok: once pnpm firmware:keys');
  process.exit(1);
}
const data = readFileSync(bin);
const signature = sign('sha256', data, readFileSync(keyPath, 'utf8')).toString('base64');
writeFileSync(`${bin}.sig`, `${signature}\n`);
console.log(
  `Imzalandi: ${bin}.sig\nsha256 ${createHash('sha256').update(data).digest('hex')}  (${data.length} bayt)`,
);
