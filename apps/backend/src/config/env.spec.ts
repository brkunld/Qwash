import { validateEnv } from './env';

const DATABASE_URL = 'postgresql://u:p@localhost:15432/db';

describe('validateEnv', () => {
  it('varsayilanlari uygular', () => {
    expect(validateEnv({ DATABASE_URL })).toEqual({
      NODE_ENV: 'development',
      BACKEND_PORT: 3001,
      LOG_LEVEL: 'info',
      DATABASE_URL,
    });
  });

  it('gecersiz degerde hata firlatir', () => {
    expect(() => validateEnv({ DATABASE_URL, BACKEND_PORT: 'abc' })).toThrow(/Gecersiz ortam/);
  });

  it('DATABASE_URL zorunludur ve postgres olmalidir', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ DATABASE_URL: 'mysql://u:p@h/db' })).toThrow(/DATABASE_URL/);
  });
});
