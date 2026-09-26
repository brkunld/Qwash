import { Logger } from '@nestjs/common';
import type { Me } from '@qwash/contracts';
import { jwtVerify, SignJWT } from 'jose';
import { PrismaClient } from '../generated/prisma/client';
import { AuthProvider, AuthTokenType, UserRole, UserStatus } from '../generated/prisma/enums';
import type { User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Tx } from '../wallet/wallet.service';
import { hashPassword, randomToken, sha256, verifyPassword } from './auth.crypto';
import {
  AccountDisabledError,
  EmailTakenError,
  GoogleEmailNotVerifiedError,
  GoogleLoginDisabledError,
  InvalidCredentialsError,
  InvalidTokenError,
  LoginRateLimitedError,
  NameLockedError,
  UnauthenticatedError,
} from './auth.errors';
import { GoogleTokenVerifier } from './google';
import type { AuthMail } from './mailer';
import { Mailer } from './mailer';

// Kimlik dogrulama (ADR-0009, SECURITY.md 1-2).
// - Access token: HS256 JWT, 15 dk, stateless.
// - Refresh token: opak, 7 gun, yalniz SHA-256 ozeti saklanir, her kullanimda dondurulur.
//   Iptal edilmis bir refresh token tekrar gelirse kullanicinin tum oturumlari kapatilir.
// - E-posta dogrulama (24 sa) ve sifre sifirlama (1 sa) token'lari tek kullanimliktir.

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
/** E-posta basina sifreli giris: pencere basina en fazla bu kadar deneme (SECURITY.md 2). */
export const LOGIN_MAX_ATTEMPTS = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const JWT_ISSUER = 'qwash';
const JWT_AUDIENCE = 'qwash-api';

export interface AuthServiceOptions {
  accessSecret: string;
  customerAppUrl: string;
  mailer: Mailer;
  google: GoogleTokenVerifier | null;
  now?: () => Date;
}

export interface IssuedSession {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  user: Me;
}

export interface AccessClaims {
  userId: string;
  role: UserRole;
}

// Olmayan kullanici icin de scrypt calistirilir; yanit suresi hesabin varligini sizdirmaz.
let dummyHash: Promise<string> | undefined;

export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  private readonly key: Uint8Array;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaService | PrismaClient,
    private readonly options: AuthServiceOptions,
  ) {
    this.key = new TextEncoder().encode(options.accessSecret);
    this.now = options.now ?? (() => new Date());
  }

  async register(input: {
    email: string;
    password: string;
    fullName: string;
  }): Promise<IssuedSession> {
    const passwordHash = await hashPassword(input.password);
    let user: User;
    try {
      user = await this.prisma.user.create({
        data: {
          email: input.email,
          passwordHash,
          fullName: input.fullName,
          wallet: { create: {} },
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new EmailTakenError();
      throw error;
    }
    await this.sendVerificationMail(user);
    return this.issueSession(user);
  }

  async login(input: { email: string; password: string }): Promise<IssuedSession> {
    // Sinir, hesap var olsun olmasin ve sifre kontrolunden once uygulanir: yanit hesap
    // varligini sizdirmaz, esazamanli istek yigini sayaci gecemez.
    await this.countLoginAttempt(input.email);
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user?.passwordHash) {
      await verifyPassword(input.password, await getDummyHash());
      throw new InvalidCredentialsError();
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      throw new InvalidCredentialsError();
    }
    assertActive(user);
    await this.clearLoginAttempts(user.email);
    return this.issueSession(user);
  }

  /** Suresi dolmus deneme pencerelerini siler (AuthWorker, saatlik). */
  async purgeLoginThrottles(): Promise<number> {
    const { count } = await this.prisma.loginThrottle.deleteMany({
      where: { windowStartedAt: { lte: new Date(this.now().getTime() - LOGIN_WINDOW_MS) } },
    });
    return count;
  }

  /**
   * Denemeyi tek atomik UPSERT ile sayar (satir kilidi: esazamanli istekler sirayla artirir).
   * Pencere doldugunda sayac 1'den yeniden baslar. Sinir asildiysa sifre kontrol edilmez.
   */
  private async countLoginAttempt(email: string): Promise<void> {
    const now = this.now();
    const cutoff = new Date(now.getTime() - LOGIN_WINDOW_MS);
    const [row] = await this.prisma.$queryRaw<{ attempts: number }[]>`
      INSERT INTO "LoginThrottle" ("key", "attempts", "windowStartedAt")
      VALUES (${loginKey(email)}, 1, ${now})
      ON CONFLICT ("key") DO UPDATE SET
        "attempts" = CASE WHEN "LoginThrottle"."windowStartedAt" <= ${cutoff}
                          THEN 1 ELSE "LoginThrottle"."attempts" + 1 END,
        "windowStartedAt" = CASE WHEN "LoginThrottle"."windowStartedAt" <= ${cutoff}
                                 THEN ${now} ELSE "LoginThrottle"."windowStartedAt" END
      RETURNING "attempts"`;
    if (row && row.attempts > LOGIN_MAX_ATTEMPTS) throw new LoginRateLimitedError();
  }

  private async clearLoginAttempts(email: string): Promise<void> {
    await this.prisma.loginThrottle.deleteMany({ where: { key: loginKey(email) } });
  }

  async loginWithGoogle(idToken: string): Promise<IssuedSession> {
    if (!this.options.google) throw new GoogleLoginDisabledError();
    let profile;
    try {
      profile = await this.options.google.verify(idToken);
    } catch {
      throw new InvalidTokenError();
    }
    if (!profile.emailVerified) throw new GoogleEmailNotVerifiedError();
    const email = profile.email.trim().toLowerCase();

    // Ilk giriste ayni kullanici icin iki istek yarisirsa unique ihlali olur; bir kez yeniden dene.
    let user: User;
    try {
      user = await this.findOrCreateGoogleUser(profile.sub, email, profile.name);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      user = await this.findOrCreateGoogleUser(profile.sub, email, profile.name);
    }
    // Google e-postanin sahibini kanitladi: sifre denemesi kilidi de kalkar.
    await this.clearLoginAttempts(user.email);
    return this.issueSession(user);
  }

  private async findOrCreateGoogleUser(
    sub: string,
    email: string,
    name: string | null,
  ): Promise<User> {
    const identity = await this.prisma.authIdentity.findUnique({
      where: { provider_providerUserId: { provider: AuthProvider.GOOGLE, providerUserId: sub } },
      include: { user: true },
    });
    if (identity) {
      assertActive(identity.user);
      return identity.user;
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email } });
      if (!existing) {
        return tx.user.create({
          data: {
            email,
            fullName: name,
            emailVerifiedAt: this.now(),
            wallet: { create: {} },
            identities: { create: { provider: AuthProvider.GOOGLE, providerUserId: sub } },
          },
        });
      }
      assertActive(existing);
      // Ayni e-postada hesap var. Google e-postanin sahibini kanitladi (ADR-0009 madde 5).
      // Yerel hesap dogrulanmamissa sifresi baskasi tarafindan konmus olabilir: sifre
      // silinir ve acik oturumlar kapatilir, boylece hesabi yalniz e-posta sahibi kullanir.
      const takeover = existing.emailVerifiedAt === null;
      if (takeover) await this.revokeAllRefreshTokens(tx, existing.id);
      await tx.authIdentity.create({
        data: { userId: existing.id, provider: AuthProvider.GOOGLE, providerUserId: sub },
      });
      return tx.user.update({
        where: { id: existing.id },
        data: {
          emailVerifiedAt: existing.emailVerifiedAt ?? this.now(),
          fullName: existing.fullName ?? name,
          ...(takeover ? { passwordHash: null } : {}),
        },
      });
    });
  }

  async refresh(refreshToken: string): Promise<IssuedSession> {
    const tokenHash = sha256(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored) throw new UnauthenticatedError();

    if (stored.revokedAt) {
      await this.revokeAllRefreshTokens(this.prisma, stored.userId);
      throw new UnauthenticatedError();
    }
    if (stored.expiresAt <= this.now()) throw new UnauthenticatedError();

    // Kosullu guncelleme: ayni token'la eszamanli iki istekten yalniz biri kazanir,
    // digeri tekrar kullanim sayilir.
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: this.now() },
    });
    if (count === 0) {
      await this.revokeAllRefreshTokens(this.prisma, stored.userId);
      throw new UnauthenticatedError();
    }

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: stored.userId } });
    assertActive(user);
    return this.issueSession(user);
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: this.now() },
    });
  }

  async resendVerification(userId: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerifiedAt) return;
    await this.sendVerificationMail(user);
  }

  async verifyEmail(token: string): Promise<void> {
    const userId = await this.consumeToken(token, AuthTokenType.EMAIL_VERIFY);
    await this.prisma.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: this.now() },
    });
  }

  /** Hesap olsun olmasin ayni sekilde doner; hesap varligi sizdirilmaz. */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== UserStatus.ACTIVE) return;
    const token = await this.createToken(
      user.id,
      AuthTokenType.PASSWORD_RESET,
      PASSWORD_RESET_TTL_MS,
    );
    this.deliver({
      to: user.email,
      kind: 'PASSWORD_RESET',
      link: this.link('/reset-password', token),
    });
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const userId = await this.consumeToken(token, AuthTokenType.PASSWORD_RESET);
    const passwordHash = await hashPassword(password);
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      await tx.user.update({
        where: { id: userId },
        // Sifirlama baglantisi e-postaya ulasildigini kanitlar.
        data: { passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? this.now() },
      });
      // Sifre degisince tum oturumlar kapanir; kullanilmamis diger sifirlama baglantilari da.
      await this.revokeAllRefreshTokens(tx, userId);
      await tx.authToken.updateMany({
        where: { userId, type: AuthTokenType.PASSWORD_RESET, usedAt: null },
        data: { usedAt: this.now() },
      });
      // Saldirgan hesabi deneme siniriyla kilitlediyse sahibi sifirlamayla hemen girebilir.
      await tx.loginThrottle.deleteMany({ where: { key: loginKey(user.email) } });
    });
  }

  async getMe(userId: string): Promise<Me> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== UserStatus.ACTIVE) throw new UnauthenticatedError();
    return toMe(user);
  }

  /** Ad, ilk basarili kart yuklemesinden sonra muhurludur; yalniz destek degistirir. */
  async updateProfile(userId: string, input: { fullName: string }): Promise<Me> {
    // Kosullu guncelleme: ayni anda sonuclanan bir yuklemenin muhruyle yarismaz.
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId, status: UserStatus.ACTIVE, nameLockedAt: null },
      data: { fullName: input.fullName },
    });
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== UserStatus.ACTIVE) throw new UnauthenticatedError();
    if (count === 0) throw new NameLockedError();
    return toMe(user);
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithms: ['HS256'],
        currentDate: this.now(),
      });
      if (typeof payload.sub !== 'string' || typeof payload.role !== 'string') {
        throw new Error('eksik claim');
      }
      return { userId: payload.sub, role: payload.role as UserRole };
    } catch {
      throw new UnauthenticatedError();
    }
  }

  private async issueSession(user: User): Promise<IssuedSession> {
    const now = this.now();
    const accessTokenExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
    const accessToken = await new SignJWT({ role: user.role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(accessTokenExpiresAt.getTime() / 1000))
      .sign(this.key);

    const refreshToken = randomToken();
    const refreshTokenExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
    await this.prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: sha256(refreshToken), expiresAt: refreshTokenExpiresAt },
    });

    return {
      accessToken,
      accessTokenExpiresAt,
      refreshToken,
      refreshTokenExpiresAt,
      user: toMe(user),
    };
  }

  private async sendVerificationMail(user: User): Promise<void> {
    const token = await this.createToken(user.id, AuthTokenType.EMAIL_VERIFY, EMAIL_VERIFY_TTL_MS);
    this.deliver({
      to: user.email,
      kind: 'EMAIL_VERIFY',
      link: this.link('/verify-email', token),
    });
  }

  /**
   * E-postayi arka planda gonderir; istek gonderimi beklemez ve hata istemciye yansimaz.
   * Bekleseydik (1) SMTP hatasi hesap olusmusken kayit istegini 500 yapardi, (2) "sifremi
   * unuttum" yaniti hesap varsa yavas, yoksa hizli donerdi ve sure farki hesabin var olup
   * olmadigini sizdirirdi. Basarisizlik loglanir; kullanici dogrulamayi yeniden isteyebilir.
   */
  private deliver(mail: AuthMail): void {
    this.options.mailer.send(mail).catch((err: unknown) => {
      this.logger.error({ err, kind: mail.kind }, 'E-posta gonderilemedi');
    });
  }

  private async createToken(userId: string, type: AuthTokenType, ttlMs: number): Promise<string> {
    const token = randomToken();
    await this.prisma.authToken.create({
      data: {
        userId,
        type,
        tokenHash: sha256(token),
        expiresAt: new Date(this.now().getTime() + ttlMs),
      },
    });
    return token;
  }

  /** Token'i atomik olarak kullanilmis isaretler; ikinci kullanim veya suresi dolmus token reddedilir. */
  private async consumeToken(token: string, type: AuthTokenType): Promise<string> {
    const tokenHash = sha256(token);
    const now = this.now();
    const { count } = await this.prisma.authToken.updateMany({
      where: { tokenHash, type, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (count === 0) throw new InvalidTokenError();
    const stored = await this.prisma.authToken.findUniqueOrThrow({ where: { tokenHash } });
    return stored.userId;
  }

  private async revokeAllRefreshTokens(
    db: Tx | PrismaService | PrismaClient,
    userId: string,
  ): Promise<void> {
    await db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
  }

  private link(path: string, token: string): string {
    const url = new URL(path, this.options.customerAppUrl);
    url.searchParams.set('token', token);
    return url.toString();
  }
}

/** E-posta tabloya acik yazilmaz; normalize edilip ozeti anahtar olur. */
function loginKey(email: string): string {
  return sha256(email.trim().toLowerCase());
}

function assertActive(user: User): void {
  if (user.status !== UserStatus.ACTIVE) throw new AccountDisabledError();
}

function toMe(user: User): Me {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    phoneNumber: user.phoneNumber,
    emailVerified: user.emailVerifiedAt !== null,
    hasPassword: user.passwordHash !== null,
    nameLocked: user.nameLockedAt !== null,
    role: user.role,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('qwash-dummy-password');
  return dummyHash;
}
