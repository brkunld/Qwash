import base from '@qwash/eslint-config/base';

export default [
  ...base,
  {
    ignores: [
      'jest.config.js',
      'jest.integration.config.js',
      'jest.load.config.js',
      'src/generated/**',
    ],
  },
  {
    rules: {
      // NestJS DI, decorator metadata icin sinif importlarinin deger olarak kalmasini ister.
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    files: ['test/global-setup.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        URL: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
];
