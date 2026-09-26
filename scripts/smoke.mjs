// Canli smoke testi: calisan bir backend'e karsi musteri, admin, API ve cihaz akislarinin
// "ayakta mi, kapilar dogru mu" kontrolu. YALNIZ OKUR: para, seans veya kayit degistirmez.
// Deploy sonrasi, saha kurulumunda ve arizadan sonra calistirilir (docs/RUNBOOK.md).
//
//   pnpm smoke
//
// Ortam (kok .env veya kabuk):
//   SMOKE_BASE_URL         varsayilan http://localhost:3001/api/v1
//   SMOKE_BAY              varsayilan BAY-001 (QR ekrani kontrolu)
//   SMOKE_CUSTOMER_EMAIL / SMOKE_CUSTOMER_PASSWORD   verilirse musteri akisi denenir
//   SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD         verilirse admin ve cihaz akisi denenir
//   SMOKE_DEVICE_MAX_AGE_SEC   cihaz "son gorulme" sinirı, varsayilan 90
//
// Not: giris ucu IP basina 15 dakikada 10 denemedir; bir smoke kosusu 2 giris harcar.
// Cikis kodu: 0 hepsi gecti (uyarilar olabilir), 1 en az bir kontrol basarisiz.
// Hesap bilgisi verilmezse o bolum ATLANIR ve bu acikca yazilir; atlanan bolum "gecti" sayilmaz.
import { loadEnv } from './lib/pg.mjs';

const env = loadEnv();
const base = (env.SMOKE_BASE_URL ?? 'http://localhost:3001/api/v1').replace(/\/$/, '');
const bay = env.SMOKE_BAY ?? 'BAY-001';
const maxAgeSec = Number(env.SMOKE_DEVICE_MAX_AGE_SEC ?? 90);

const results = { ok: 0, fail: 0, warn: 0, skip: 0 };
const log = (mark, name, detail = '') =>
  console.log(`${mark} ${name}${detail ? `  (${detail})` : ''}`);
const pass = (name, detail) => (results.ok++, log('OK  ', name, detail));
const fail = (name, detail) => (results.fail++, log('HATA', name, detail));
const warn = (name, detail) => (results.warn++, log('UYARI', name, detail));
const skip = (name, detail) => (results.skip++, log('ATLA', name, detail));

// Hiz siniri (429) smoke'un kendi art arda calismasindan da gelebilir: Retry-After kadar
// (en fazla 65 sn) bekleyip bir kez yeniden dener; yoksa sahte hata uretirdi.
async function call(method, path, opts = {}) {
  const r = await callOnce(method, path, opts);
  if (r.status !== 429 || !(r.retryAfterSec <= 65)) return r;
  console.log(`  ... hiz siniri (429), ${r.retryAfterSec} sn bekleniyor: ${method} ${path}`);
  await new Promise((done) => setTimeout(done, (r.retryAfterSec + 1) * 1000));
  return callOnce(method, path, opts);
}

async function callOnce(method, path, { token, body } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    // API yanitlari { success, data, metadata } zarfinda gelir; icerigi ac.
    return {
      status: res.status,
      json: json?.data ?? json,
      retryAfterSec: Number(res.headers.get('retry-after')),
      ms: Date.now() - started,
    };
  } catch (err) {
    return { status: 0, error: err.message, ms: Date.now() - started };
  }
}

function describeFailure(r, expected) {
  if (r.status === 0) return `baglanti hatasi: ${r.error}`;
  if (r.status === 429)
    return `hiz siniri (429), ${r.retryAfterSec || '?'} sn sonra tekrar deneyin; bu kontrol YAPILAMADI`;
  return `HTTP ${r.status}, beklenen ${String(expected)}`;
}

/** `expected`: tek kod, kod dizisi veya (status) => boolean. */
async function check(name, method, path, expected, opts, extra) {
  const r = await call(method, path, opts);
  const okStatus = Array.isArray(expected)
    ? expected.includes(r.status)
    : typeof expected === 'function'
      ? expected(r.status)
      : r.status === expected;
  if (!okStatus) {
    fail(name, describeFailure(r, expected));
    return r;
  }
  const problem = extra?.(r);
  if (problem) fail(name, problem);
  else pass(name, `${r.status}, ${r.ms} ms`);
  return r;
}

async function login(label, email, password) {
  const r = await call('POST', '/auth/login', { body: { email, password } });
  if (r.status !== 200 || !r.json?.accessToken) {
    fail(`${label} girisi`, describeFailure(r, 200));
    return undefined;
  }
  pass(`${label} girisi`, `${r.ms} ms`);
  return r.json.accessToken;
}

console.log(`Smoke testi: ${base}\n`);

// 1) Altyapi ve herkese acik kapilar
console.log('-- Servis ve herkese acik uclar');
const health = await check('GET /health', 'GET', '/health', 200, {}, (r) =>
  r.json?.status === 'ok' ? undefined : 'status "ok" degil',
);
if (health.status === 0) {
  console.log(
    '\nBackend\'e ulasilamiyor; kalan kontroller anlamsiz. docs/RUNBOOK.md > "Backend cevap vermiyor".',
  );
  process.exit(1);
}
await check(`GET /bays/${bay} (QR onay ekrani)`, 'GET', `/bays/${bay}`, 200, {}, (r) =>
  r.json?.bayCode === bay ? undefined : 'bayCode uyusmuyor',
);
await check('GET /bays/BAY-YOK (bilinmeyen peron)', 'GET', '/bays/BAY-YOK', 404);

// 2) Kimliksiz istek reddedilmeli
console.log('\n-- Korumali uclar kimliksiz reddediliyor mu');
for (const [method, path] of [
  ['GET', '/wallet'],
  ['GET', '/sessions/active'],
  ['POST', '/sessions'],
  ['GET', '/admin/bays'],
  ['POST', '/admin/cash-topups'],
]) {
  await check(
    `${method} ${path} kimliksiz`,
    method,
    path,
    401,
    method === 'POST' ? { body: {} } : {},
  );
}
await check(
  'POST /payments/webhook imzasiz',
  'POST',
  '/payments/webhook',
  (s) => s >= 400 && s < 500,
  {
    body: { smoke: true },
  },
);

// 3) Musteri akisi
console.log('\n-- Musteri akisi');
if (env.SMOKE_CUSTOMER_EMAIL && env.SMOKE_CUSTOMER_PASSWORD) {
  const token = await login('Musteri', env.SMOKE_CUSTOMER_EMAIL, env.SMOKE_CUSTOMER_PASSWORD);
  if (token) {
    await check('GET /me', 'GET', '/me', 200, { token }, (r) =>
      r.json?.email ? undefined : 'email yok',
    );
    await check('GET /wallet', 'GET', '/wallet', 200, { token }, (r) =>
      Number.isInteger(r.json?.balanceKurus) &&
      r.json.availableKurus === r.json.balanceKurus - r.json.holdKurus
        ? undefined
        : 'bakiye alanlari tutarsiz',
    );
    await check('GET /payments/topup-options', 'GET', '/payments/topup-options', 200, { token });
    await check('GET /sessions/active', 'GET', '/sessions/active', [200, 404], { token });
    await check('Musteri admin ucuna giremez (GET /admin/bays)', 'GET', '/admin/bays', 403, {
      token,
    });
  }
} else {
  skip('Musteri akisi', 'SMOKE_CUSTOMER_EMAIL / SMOKE_CUSTOMER_PASSWORD verilmedi');
}

// 4) Admin ve cihaz akisi
console.log('\n-- Admin ve cihaz akisi');
if (env.SMOKE_ADMIN_EMAIL && env.SMOKE_ADMIN_PASSWORD) {
  const token = await login('Admin', env.SMOKE_ADMIN_EMAIL, env.SMOKE_ADMIN_PASSWORD);
  if (token) {
    await check('GET /admin/me', 'GET', '/admin/me', 200, { token });
    await check('GET /admin/programs', 'GET', '/admin/programs', 200, { token }, (r) =>
      Array.isArray(r.json) && r.json.length > 0 ? undefined : 'program listesi bos',
    );
    const stations = await check(
      'GET /admin/stations',
      'GET',
      '/admin/stations',
      200,
      { token },
      (r) => (Array.isArray(r.json) && r.json.length > 0 ? undefined : 'istasyon listesi bos'),
    );
    const stationId = Array.isArray(stations.json) ? stations.json[0]?.id : undefined;
    if (stationId) {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(
        new Date(),
      );
      await check(
        `GET /admin/reports/cash (${today})`,
        'GET',
        `/admin/reports/cash?date=${today}&stationId=${stationId}`,
        200,
        { token },
      );
    }
    await check('GET /admin/audit-logs', 'GET', '/admin/audit-logs', 200, { token });
    await check(
      'GET /admin/sessions/review',
      'GET',
      '/admin/sessions/review',
      200,
      { token },
      (r) => {
        const n = Array.isArray(r.json) ? r.json.length : (r.json?.items?.length ?? 0);
        if (n > 0)
          warn('Inceleme kuyrugunda bekleyen seans var', `${n} adet; admin panelinde "Inceleme"`);
        return undefined;
      },
    );

    const bays = await check('GET /admin/bays', 'GET', '/admin/bays', 200, { token }, (r) =>
      Array.isArray(r.json) && r.json.length > 0 ? undefined : 'peron listesi bos',
    );
    for (const b of Array.isArray(bays.json) ? bays.json : []) {
      const label = `Peron ${b.bayCode} cihazi`;
      if (b.status === 'MAINTENANCE') {
        warn(label, 'bakimda (musteri baslatamaz)');
      } else if (!b.device) {
        fail(label, 'cihaz kaydi yok (NO_DEVICE)');
      } else {
        const ageSec = Math.round((Date.now() - Date.parse(b.device.lastSeenAt)) / 1000);
        if (b.status === 'OFFLINE' || ageSec > maxAgeSec) {
          fail(
            label,
            `cevrimdisi: en son ${ageSec} sn once gorundu (sinir ${maxAgeSec} sn), fw ${b.device.firmwareVersion ?? '?'}`,
          );
        } else if (b.problem) {
          warn(label, `cevrimici ama baslatilamaz: ${b.problem}`);
        } else if (b.device.driftKind) {
          warn(label, `cihaz/backend sapmasi: ${b.device.driftKind}`);
        } else {
          pass(
            label,
            `${b.status}, son gorulme ${ageSec} sn, fw ${b.device.firmwareVersion ?? '?'}`,
          );
        }
      }
    }
  }
} else {
  skip('Admin ve cihaz akisi', 'SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD verilmedi');
}

console.log(
  `\nSonuc: ${results.ok} gecti, ${results.fail} hata, ${results.warn} uyari, ${results.skip} atlandi.`,
);
if (results.skip > 0)
  console.log('Atlanan bolumler dogrulanmadi; hesap bilgisi verip yeniden calistirin.');
process.exit(results.fail > 0 ? 1 : 0);
