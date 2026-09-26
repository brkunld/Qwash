// Yedegi GECICI bir veritabanina geri yukler ve dogrular; gercek veritabanina dokunmaz.
// Kullanim: pnpm db:restore-verify [yedek-dosyasi]   (dosya verilmezse en yeni yedek)
// Kontroller: (1) pg_restore hatasiz biter, (2) tablo satir sayilari raporlanir (yedekten sonra
// canli veri degismis olabilir; fark yalniz uyaridir), (3) her cuzdanda
//   bakiye = SUM(CREDIT) - SUM(DEBIT) - SUM(CAPTURE)  ve  bloke = SUM(HOLD) - SUM(RELEASE) - SUM(CAPTURE)
// geri yuklenen kopyada tutmalidir; tutmazsa basarisiz olur.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { backupDir, loadEnv, pgSettings, psql } from './lib/pg.mjs';

const pg = pgSettings(loadEnv());
const admin = 'postgres';
const scratch = `qwash_restore_check_${Date.now()}`;
let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(`X ${msg}`);
};

function pickFile() {
  if (process.argv[2]) return resolve(process.argv[2]);
  const latest = existsSync(backupDir)
    ? readdirSync(backupDir)
        .filter((f) => /^qwash-.*\.dump$/.test(f))
        .sort()
        .at(-1)
    : undefined;
  if (!latest) {
    console.error('backups/ altinda yedek yok. Once: pnpm db:backup');
    process.exit(1);
  }
  return resolve(backupDir, latest);
}

const countSql = `SELECT c.relname || '|' || (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.' || quote_ident(c.relname), false, true, '')))[1]::text FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`;
const tableCounts = (db) => Object.fromEntries(psql(pg, db, countSql).map((l) => l.split('|')));

const sumOf = (types) =>
  `COALESCE(SUM(l."amountKurus") FILTER (WHERE l.type IN (${types.map((t) => `'${t}'`).join(',')})), 0)`;
const expectedBalance = `${sumOf(['CREDIT'])} - ${sumOf(['DEBIT', 'CAPTURE'])}`;
const expectedHold = `${sumOf(['HOLD'])} - ${sumOf(['RELEASE', 'CAPTURE'])}`;
const mismatchSql = `SELECT w.id || '|' || w."balanceKurus" || '|' || w."holdKurus" || '|' || (${expectedBalance}) || '|' || (${expectedHold}) FROM "Wallet" w LEFT JOIN "LedgerEntry" l ON l."walletId" = w.id GROUP BY w.id HAVING w."balanceKurus" <> (${expectedBalance}) OR w."holdKurus" <> (${expectedHold})`;

const file = pickFile();
console.log(`Yedek: ${file}\nGecici veritabani: ${scratch}`);
try {
  psql(pg, admin, `CREATE DATABASE ${scratch}`);
  const restore = spawn(
    'docker',
    [
      'exec',
      '-i',
      pg.container,
      'pg_restore',
      '-U',
      pg.user,
      '-d',
      scratch,
      '--no-owner',
      '--exit-on-error',
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  createReadStream(file).pipe(restore.stdin);
  const code = await new Promise((done) => restore.on('close', done));
  if (code !== 0) throw new Error(`pg_restore basarisiz (cikis kodu ${code})`);
  console.log('OK pg_restore hatasiz bitti.');

  const restored = tableCounts(scratch);
  const source = tableCounts(pg.db);
  const tables = Object.keys(restored);
  if (tables.length === 0) fail('Geri yuklenen veritabaninda hic tablo yok.');
  for (const t of tables) {
    if (restored[t] !== source[t]) {
      console.warn(
        `! ${t}: yedekte ${restored[t]} satir, canlida ${source[t] ?? '-'} (yedekten sonra degismis olabilir)`,
      );
    }
  }
  const total = tables.reduce((sum, t) => sum + Number(restored[t]), 0);
  console.log(`OK ${tables.length} tablo geri yuklendi, toplam ${total} satir.`);

  const bad = psql(pg, scratch, mismatchSql);
  const wallets = psql(pg, scratch, `SELECT count(*) FROM "Wallet"`)[0];
  if (bad.length) {
    fail(
      `${bad.length} cuzdanda ledger mutabakati TUTMUYOR (id|bakiye|bloke|beklenen bakiye|beklenen bloke):\n${bad.join('\n')}`,
    );
  } else {
    console.log(`OK ${wallets} cuzdanin ledger mutabakati geri yuklenen kopyada tutuyor.`);
  }
} catch (err) {
  fail(err.message);
} finally {
  try {
    psql(pg, admin, `DROP DATABASE IF EXISTS ${scratch}`);
    console.log('Gecici veritabani silindi.');
  } catch (err) {
    console.error(
      `Gecici veritabani silinemedi (elle silin: DROP DATABASE ${scratch}): ${err.message}`,
    );
    failed = true;
  }
}
console.log(
  failed
    ? '\nSONUC: BASARISIZ'
    : '\nSONUC: BASARILI, yedek geri yuklenebilir ve para kayitlari tutarli.',
);
process.exit(failed ? 1 : 0);
