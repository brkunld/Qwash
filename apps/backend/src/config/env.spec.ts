import { validateEnv } from './env';

describe('validateEnv', () => {
  it('varsayilanlari uygular', () => {
    expect(validateEnv({})).toEqual({
      NODE_ENV: 'development',
      BACKEND_PORT: 3001,
      LOG_LEVEL: 'info',
    });
  });

  it('gecersiz degerde hata firlatir', () => {
    expect(() => validateEnv({ BACKEND_PORT: 'abc' })).toThrow(/Gecersiz ortam/);
  });
});
