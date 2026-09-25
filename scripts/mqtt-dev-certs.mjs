// Gelistirme broker'i icin TLS: yerel CA + sunucu sertifikasi uretir ve CA'yi firmware'e yazar.
//   docker/mosquitto/certs/{ca.crt,ca.key,server.crt,server.key}  (git disi)
//   firmware/qwash_bay/mqtt_ca.h                                    (git disi)
// Sunucu SAN'i: localhost + MQTT_TLS_SANS (.env, virgulle IP/ad; cihazin baglandigi LAN IP'si olmali).
// CA varsa korunur (cihazdaki CA gecerli kalsin); yalnizca sunucu sertifikasi yenilenir. --new-ca ile CA da yenilenir.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';

const env = Object.fromEntries(
  readFileSync(resolve('.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const sans = ['localhost', '127.0.0.1', ...(env.MQTT_TLS_SANS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];

const openssl = ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe'].find((bin) => {
  try {
    execFileSync(bin, ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});
if (!openssl) {
  console.error('mqtt:certs: openssl bulunamadi (Git for Windows ile gelir)');
  process.exit(1);
}
const run = (...args) => execFileSync(openssl, args, { stdio: ['ignore', 'ignore', 'inherit'] });

const dir = resolve('docker/mosquitto/certs');
mkdirSync(dir, { recursive: true });
const f = (n) => resolve(dir, n);

if (process.argv.includes('--new-ca') || !existsSync(f('ca.crt'))) {
  run('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', f('ca.key'), '-out', f('ca.crt'), '-days', '3650', '-subj', '/CN=Qwash Dev MQTT CA');
  console.log('mqtt:certs: yeni CA uretildi (cihaza yeni firmware yuklenmeli)');
}

const ext = [
  'basicConstraints=CA:FALSE',
  'keyUsage=digitalSignature',
  'extendedKeyUsage=serverAuth',
  `subjectAltName=${sans.map((s) => (isIP(s) ? `IP:${s}` : `DNS:${s}`)).join(',')}`,
].join('\n');
writeFileSync(f('server.ext'), ext);
run('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
  '-keyout', f('server.key'), '-out', f('server.csr'), '-subj', '/CN=qwash-dev-broker');
run('x509', '-req', '-in', f('server.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-CAcreateserial',
  '-out', f('server.crt'), '-days', '825', '-extfile', f('server.ext'));
rmSync(f('server.csr'));
rmSync(f('server.ext'));

const ca = readFileSync(f('ca.crt'), 'utf8').trim();
writeFileSync(
  resolve('firmware/qwash_bay/mqtt_ca.h'),
  `#pragma once\n// pnpm mqtt:certs ile uretildi; git disi. Broker sertifikasini imzalayan gelistirme CA'si.\nstatic const char MQTT_CA_CERT[] = R"PEM(\n${ca}\n)PEM";\n`,
);
console.log(`mqtt:certs: sunucu sertifikasi yazildi, SAN: ${sans.join(', ')}`);
