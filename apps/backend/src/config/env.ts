import { z } from 'zod';

// Uygulama baslarken ortam degiskenleri dogrulanir; eksik/yanlis deger varsa hemen durur.
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BACKEND_PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  MQTT_URL: z.url({ protocol: /^mqtts?$/ }).default('mqtt://localhost:11883'),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Gecersiz ortam degiskenleri:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
