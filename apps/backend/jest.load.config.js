// Yuk testleri (Faz 7): gercek PostgreSQL (qwash_test) gerektirir, CI'a dahil degil.
// Calistirma: pnpm --filter @qwash/backend test:load
/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: 'test/load/.*\\.load-spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  globalSetup: '<rootDir>/test/global-setup.js',
  maxWorkers: 1,
  testTimeout: 300000,
};
