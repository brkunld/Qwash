import { z } from 'zod';

// Kartla bakiye yukleme sozlesmeleri (Faz 5b, API.md "Cuzdan & Odeme").

export const TopUpOptionsSchema = z.object({
  minKurus: z.number().int(),
  maxKurus: z.number().int(),
  /** Admin'in minimumunun katlari (min, 2*min, 4*min); max'i asanlar cikarilir. */
  presetsKurus: z.array(z.number().int()),
});
export type TopUpOptions = z.infer<typeof TopUpOptionsSchema>;

export const StartTopUpRequestSchema = z.object({
  amountKurus: z.number().int().positive(),
});
export type StartTopUpRequest = z.infer<typeof StartTopUpRequestSchema>;

export const TopUpStatusSchema = z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED']);
export type TopUpStatus = z.infer<typeof TopUpStatusSchema>;

export const TopUpViewSchema = z.object({
  topUpId: z.string(),
  status: TopUpStatusSchema,
  amountKurus: z.number().int(),
  /** PENDING iken musterinin yonlendirilecegi Iyzico odeme sayfasi. */
  paymentPageUrl: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type TopUpView = z.infer<typeof TopUpViewSchema>;
