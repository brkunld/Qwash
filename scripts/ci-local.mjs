// GitHub Actions (.github/workflows/ci.yml) adimlarini yerelde ayni sirayla calistirir.
// Actions calismadigi surece (hesap fatura kilidi) PR/push oncesi dogrulama budur.
//   pnpm ci:local           tum adimlar
//   pnpm ci:local --quick   entegrasyon testi, build ve gitleaks haric (hizli kontrol)
// Entegrasyon testi icin altyapi ayakta olmali: pnpm infra:up
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const quick = process.argv.includes('--quick');
const repo = resolve('.');

const steps = [
  ['install', 'pnpm', ['install', '--frozen-lockfile', '--prefer-offline']],
  ['format:check', 'pnpm', ['format:check']],
  ['lint', 'pnpm', ['lint']],
  ['typecheck', 'pnpm', ['typecheck']],
  ['test', 'pnpm', ['test']],
  ...(quick
    ? []
    : [
        ['test:integration', 'pnpm', ['test:integration']],
        // GitHub'daki `pnpm build` ile ayni derleme; yalniz backend ciktisi dist-ci/'ye gider
        // ki acik `pnpm dev`'in dist/ klasoru silinip backend cokmesin.
        ['build', 'pnpm', ['exec', 'turbo', 'run', 'build:ci']],
      ]),
  ['infra:check', 'pnpm', ['infra:check']],
  ...(quick
    ? []
    : [
        [
          'gitleaks',
          'docker',
          [
            'run',
            '--rm',
            '-v',
            `${repo}:/repo`,
            'zricethezav/gitleaks:latest',
            'git',
            '/repo',
            '--no-banner',
            '--redact',
          ],
        ],
      ]),
];

const started = Date.now();
for (const [name, cmd, args] of steps) {
  const t = Date.now();
  process.stdout.write(`ci:local  ${name.padEnd(17)}`);
  // Windows'ta pnpm bir .cmd betigi; kabuk gerekir. Argumanlar bu dosyada sabit oldugu icin
  // tek komut satiri olarak verilir (argumanlarla shell: true Node'da kullanimdan kalkti).
  const win = process.platform === 'win32';
  const line = [cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  const r = spawnSync(win ? line : cmd, win ? [] : args, {
    cwd: repo,
    shell: win,
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1', FORCE_COLOR: '0' },
  });
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  if (r.status !== 0) {
    console.log(`BASARISIZ (${secs} sn)\n`);
    console.log(`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n'));
    if (name === 'test:integration') console.log('\nAltyapi ayakta mi? pnpm infra:up');
    process.exit(1);
  }
  console.log(`ok (${secs} sn)`);
}
console.log(`ci:local  hepsi gecti (${((Date.now() - started) / 1000).toFixed(0)} sn)`);
