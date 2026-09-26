import { z } from 'zod';

// Musteri kimlik dogrulama sozlesmeleri (ADR-0009, API.md "Kimlik Dogrulama").

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Gecerli bir e-posta adresi girin.' }))
  .pipe(z.string().max(254));

// Uzunluk tek kural: karmasiklik kurali yerine en az 8 karakter (NIST 800-63B).
// 72 ust siniri istek boyutunu sinirlamak icin.
export const PasswordSchema = z
  .string()
  .min(8, { message: 'Sifre en az 8 karakter olmali.' })
  .max(72, { message: 'Sifre en fazla 72 karakter olabilir.' });

export const FullNameSchema = z.string().trim().min(2).max(100);

export const RegisterRequestSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  fullName: FullNameSchema,
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(72),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const GoogleLoginRequestSchema = z.object({
  idToken: z.string().min(1).max(4096),
});
export type GoogleLoginRequest = z.infer<typeof GoogleLoginRequestSchema>;

export const TokenRequestSchema = z.object({
  token: z.string().min(1).max(200),
});
export type TokenRequest = z.infer<typeof TokenRequestSchema>;

export const ForgotPasswordRequestSchema = z.object({ email: EmailSchema });
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

export const ResetPasswordRequestSchema = z.object({
  token: z.string().min(1).max(200),
  password: PasswordSchema,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

export const UpdateProfileRequestSchema = z.object({
  fullName: FullNameSchema,
});
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

export const MeSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string().nullable(),
  phoneNumber: z.string().nullable(),
  emailVerified: z.boolean(),
  hasPassword: z.boolean(),
  /** Ilk basarili kart yuklemesinden sonra true; ad artik profilden degismez. */
  nameLocked: z.boolean(),
  role: z.enum(['USER', 'ADMIN', 'SUPER_ADMIN']),
});
export type Me = z.infer<typeof MeSchema>;

// Refresh token yaniti icinde yoktur; HTTP-only cookie ile tasinir (SECURITY.md 1.1).
export const AuthResponseSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.string(),
  user: MeSchema,
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;
