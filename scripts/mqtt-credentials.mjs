// Gelistirme broker'i icin docker/mosquitto/passwd dosyasini .env'den uretir.
// Kullanicilar: backend (MQTT_URL icindeki kimlik), saglik kontrolu ve cihazlar
// (MQTT_DEVICE_CREDENTIALS="deviceId:sifre,deviceId:sifre"). Sifreler mosquitto_passwd ile hash'lenir.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const env = Object.fromEntries(
  readFileSync(resolve('.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);

const fail = (msg) => {
  console.error(`mqtt:credentials: ${msg}`);
  process.exit(1);
};

const url = new URL(env.MQTT_URL ?? fail('MQTT_URL yok'));
if (!url.username || !url.password)
  fail('MQTT_URL kullanici:sifre icermeli (mqtt://qwash-backend:...@host)');

const users = [
  [decodeURIComponent(url.username), decodeURIComponent(url.password)],
  ['qwash-health', env.MQTT_HEALTH_PASSWORD || fail('MQTT_HEALTH_PASSWORD yok')],
  ...(env.MQTT_DEVICE_CREDENTIALS ?? '')
    .split(',')
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(':');
      if (i < 1) fail(`MQTT_DEVICE_CREDENTIALS bicimi hatali: ${pair}`);
      return [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
    }),
];
for (const [user, pass] of users) {
  if (/[:\s]/.test(user) || pass.length < 12)
    fail(`${user}: kullanici adi ':' iceremez, sifre en az 12 karakter`);
}

const dir = resolve('docker/mosquitto');
writeFileSync(resolve(dir, 'passwd'), users.map(([u, p]) => `${u}:${p}`).join('\n') + '\n');
// Duz metni yerinde hash'le; sifreler diskte acik kalmaz.
execFileSync(
  'docker',
  ['run', '--rm', '-v', `${dir}:/m`, 'eclipse-mosquitto:2', 'mosquitto_passwd', '-U', '/m/passwd'],
  {
    stdio: 'inherit',
  },
);
console.log(
  `mqtt:credentials: ${users.length} kullanici yazildi (${users.map(([u]) => u).join(', ')})`,
);
