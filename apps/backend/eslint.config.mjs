import base from '@qwash/eslint-config/base';

export default [
  ...base,
  {
    ignores: ['jest.config.js'],
  },
  {
    rules: {
      // NestJS DI, decorator metadata icin sinif importlarinin deger olarak kalmasini ister.
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
];
