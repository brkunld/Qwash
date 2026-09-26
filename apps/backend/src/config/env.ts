import { z } from 'zod';

// Uygulama baslarken ortam degiskenleri dogrulanir; eksik/yanlis deger varsa hemen durur.
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BACKEND_PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  MQTT_URL: z.url({ protocol: /^mqtts?$/ }).default('mqtt://localhost:11883'),
  // Access token imza anahtari (HS256), en az 32 karakter rastgele (SECURITY.md).
  JWT_ACCESS_SECRET: z.string().min(32),
  // Google OAuth client id; tanimli degilse Google girisi kapali.
  GOOGLE_CLIENT_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  // E-postadaki dogrulama/sifirlama baglantilarinin acilacagi musteri PWA adresi.
  CUSTOMER_APP_URL: z.url().default('http://localhost:3000'),
  // Tarayicidan API'ye cookie ile istek atabilecek kaynaklar (virgulle ayrilir).
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  // Iyzico odeme formunun donecegi API adresi (callback: <API_PUBLIC_URL>/api/v1/payments/iyzico/callback).
  API_PUBLIC_URL: z.url().default('http://localhost:3001'),
  // Iyzico anahtarlari; tanimli degilse kart yukleme kapali (ADR-0003).
  IYZICO_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  IYZICO_SECRET_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  IYZICO_BASE_URL: z.url().default('https://sandbox-api.iyzipay.com'),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Gecersiz ortam degiskenleri:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
