// Entegrasyon testleri: gercek PostgreSQL gerektirir (pnpm infra:up).
/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: 'test/.*\\.int-spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  globalSetup: '<rootDir>/test/global-setup.js',
  // Testler ayni veritabanini paylasir; dosyalar sirayla calisir.
  maxWorkers: 1,
  testTimeout: 30000,
};
