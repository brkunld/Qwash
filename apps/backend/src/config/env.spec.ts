import { validateEnv } from './env';

const DATABASE_URL = 'postgresql://u:p@localhost:15432/db';
const JWT_ACCESS_SECRET = 'x'.repeat(32);
const base = { DATABASE_URL, JWT_ACCESS_SECRET };

describe('validateEnv', () => {
  it('varsayilanlari uygular', () => {
    expect(validateEnv(base)).toEqual({
      NODE_ENV: 'development',
      BACKEND_PORT: 3001,
      LOG_LEVEL: 'info',
      DATABASE_URL,
      MQTT_URL: 'mqtt://localhost:11883',
      JWT_ACCESS_SECRET,
      CUSTOMER_APP_URL: 'http://localhost:3000',
      TRUST_PROXY: 0,
      CORS_ORIGINS: 'http://localhost:3000,http://localhost:3002',
      API_PUBLIC_URL: 'http://localhost:3001',
      IYZICO_BASE_URL: 'https://sandbox-api.iyzipay.com',
      SMTP_PORT: 587,
      SMTP_SECURE: false,
    });
  });

  it('SMTP: host verilirse gonderen zorunlu, kullanici ve sifre birlikte verilir', () => {
    const smtp = { ...base, SMTP_HOST: 'smtp.gmail.com' };
    expect(() => validateEnv(smtp)).toThrow(/MAIL_FROM/);
    const ok = validateEnv({
      ...smtp,
      MAIL_FROM: 'QWash <a@b.com>',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
    });
    expect(ok).toMatchObject({ SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: 465, SMTP_SECURE: true });
    expect(() => validateEnv({ ...smtp, MAIL_FROM: 'a@b.com', SMTP_USER: 'u' })).toThrow(
      /SMTP_PASSWORD/,
    );
    expect(validateEnv({ ...base, SMTP_HOST: '' }).SMTP_HOST).toBeUndefined();
  });

  it('MQTT_URL yalnizca mqtt/mqtts olabilir', () => {
    expect(() => validateEnv({ ...base, MQTT_URL: 'http://h:1883' })).toThrow(/MQTT_URL/);
    expect(validateEnv({ ...base, MQTT_URL: 'mqtts://h:8883' }).MQTT_URL).toBe('mqtts://h:8883');
  });

  it('gecersiz degerde hata firlatir', () => {
    expect(() => validateEnv({ ...base, BACKEND_PORT: 'abc' })).toThrow(/Gecersiz ortam/);
  });

  it('DATABASE_URL zorunludur ve postgres olmalidir', () => {
    expect(() => validateEnv({ JWT_ACCESS_SECRET })).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ ...base, DATABASE_URL: 'mysql://u:p@h/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('bos GOOGLE_CLIENT_ID Google girisini kapatir', () => {
    expect(validateEnv({ ...base, GOOGLE_CLIENT_ID: '' }).GOOGLE_CLIENT_ID).toBeUndefined();
    expect(validateEnv({ ...base, GOOGLE_CLIENT_ID: 'abc' }).GOOGLE_CLIENT_ID).toBe('abc');
  });

  it('JWT_ACCESS_SECRET zorunludur ve en az 32 karakterdir', () => {
    expect(() => validateEnv({ DATABASE_URL })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => validateEnv({ DATABASE_URL, JWT_ACCESS_SECRET: 'kisa' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });
});
