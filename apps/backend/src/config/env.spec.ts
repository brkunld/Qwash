import { validateEnv } from './env';

const DATABASE_URL = 'postgresql://u:p@localhost:15432/db';

describe('validateEnv', () => {
  it('varsayilanlari uygular', () => {
    expect(validateEnv({ DATABASE_URL })).toEqual({
      NODE_ENV: 'development',
      BACKEND_PORT: 3001,
      LOG_LEVEL: 'info',
      DATABASE_URL,
      MQTT_URL: 'mqtt://localhost:11883',
    });
  });

  it('MQTT_URL yalnizca mqtt/mqtts olabilir', () => {
    expect(() => validateEnv({ DATABASE_URL, MQTT_URL: 'http://h:1883' })).toThrow(/MQTT_URL/);
    expect(validateEnv({ DATABASE_URL, MQTT_URL: 'mqtts://h:8883' }).MQTT_URL).toBe(
      'mqtts://h:8883',
    );
  });

  it('gecersiz degerde hata firlatir', () => {
    expect(() => validateEnv({ DATABASE_URL, BACKEND_PORT: 'abc' })).toThrow(/Gecersiz ortam/);
  });

  it('DATABASE_URL zorunludur ve postgres olmalidir', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ DATABASE_URL: 'mysql://u:p@h/db' })).toThrow(/DATABASE_URL/);
  });
});
