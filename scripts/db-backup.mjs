// PostgreSQL yedegi: docker icindeki pg_dump ile ozel (-Fc, sikistirilmis) bicimde alir.
//   backups/qwash-<zaman>.dump   (git disi; icinde kisisel veri ve para kayitlari vardir)
// Kullanim: pnpm db:backup   (kok dizinden, kok .env'i okur)
// Ortam: QWASH_PG_CONTAINER (varsayilan qwash-dev-postgres-1), BACKUP_KEEP (varsayilan 14).
// Yedegin gercekten ise yaradigi ancak geri yuklenince bellidir: pnpm db:restore-verify
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { backupDir, loadEnv, pgSettings } from './lib/pg.mjs';

const env = loadEnv();
const pg = pgSettings(env);
const keep = Number(env.BACKUP_KEEP ?? 14);
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const file = resolve(backupDir, `qwash-${stamp}.dump`);

const out = createWriteStream(file);
const dump = spawn(
  'docker',
  ['exec', pg.container, 'pg_dump', '-U', pg.user, '-d', pg.db, '-Fc', '--no-owner'],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
dump.stdout.pipe(out);
const code = await new Promise((done) => dump.on('close', done));
await new Promise((done) => out.end(done));

if (code !== 0 || statSync(file).size < 1024) {
  rmSync(file, { force: true });
  console.error(`Yedek ALINAMADI (pg_dump cikis kodu ${code}).`);
  process.exit(1);
}
console.log(`Yedek alindi: ${file} (${(statSync(file).size / 1024).toFixed(0)} KB)`);

const old = readdirSync(backupDir)
  .filter((f) => /^qwash-.*\.dump$/.test(f))
  .sort()
  .slice(0, -keep);
for (const f of old) rmSync(resolve(backupDir, f));
if (old.length) console.log(`${old.length} eski yedek silindi (son ${keep} tutulur).`);
