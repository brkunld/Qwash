// Entegrasyon testleri oncesi: test veritabanini olusturur ve migration'lari uygular.
// Gelistirme veritabanina (qwash_dev) dokunulmaz.
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { Client } = require('pg');

module.exports = async function globalSetup() {
  const rootEnv = resolve(__dirname, '../../../.env');
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

  const url = process.env.TEST_DATABASE_URL ?? deriveTestUrl(process.env.DATABASE_URL);
  process.env.TEST_DATABASE_URL = url;

  const target = new URL(url);
  const dbName = target.pathname.slice(1);
  if (!/_test$/.test(dbName)) {
    throw new Error(`Guvenlik: test veritabani adi "_test" ile bitmeli (${dbName})`);
  }

  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (rowCount === 0) await client.query(`CREATE DATABASE "${dbName}"`);
  await client.end();

  const prismaCli = resolve(require.resolve('prisma/package.json'), '..', 'build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
};

function deriveTestUrl(devUrl) {
  if (!devUrl) throw new Error('DATABASE_URL veya TEST_DATABASE_URL tanimli olmali');
  const u = new URL(devUrl);
  u.pathname = `${u.pathname.replace(/_dev$/, '')}_test`;
  return u.toString();
}
