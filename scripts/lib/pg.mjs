// db-backup ve db-restore-verify icin ortak yardimcilar: .env okuma, docker uzerinden psql.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnv() {
  const file = resolve('.env');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const fromFile = Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );
  return { ...fromFile, ...process.env };
}

export function pgSettings(env = loadEnv()) {
  return {
    container: env.QWASH_PG_CONTAINER ?? 'qwash-dev-postgres-1',
    user: env.POSTGRES_USER ?? 'qwash',
    db: env.POSTGRES_DB ?? 'qwash_dev',
  };
}

export const backupDir = resolve('backups');

/** Verilen veritabaninda SQL calistirir; ciktiyi (tuples-only, ayirici '|') satir dizisi verir. */
export function psql({ container, user }, db, sql) {
  const out = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'psql',
      '-U',
      user,
      '-d',
      db,
      '-X',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  );
  return out.split(/\r?\n/).filter(Boolean);
}
