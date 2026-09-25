import {
  AccountDisabledError,
  EmailTakenError,
  GoogleEmailNotVerifiedError,
  GoogleLoginDisabledError,
  InvalidCredentialsError,
  InvalidTokenError,
  UnauthenticatedError,
} from '../src/auth/auth.errors';
import {
  ACCESS_TOKEN_TTL_MS,
  AuthService,
  EMAIL_VERIFY_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
} from '../src/auth/auth.service';
import { GoogleProfile, GoogleTokenVerifier } from '../src/auth/google';
import { CapturingMailer } from '../src/auth/mailer';
import { PrismaClient } from '../src/generated/prisma/client';
import { UserStatus } from '../src/generated/prisma/enums';
import { resetDatabase, testPrisma } from './db';

const SECRET = 'test-secret-that-is-at-least-32-chars!!';

/** Token olarak profilin JSON'unu kabul eden sahte Google dogrulayicisi. */
class FakeGoogle extends GoogleTokenVerifier {
  verify(idToken: string): Promise<GoogleProfile> {
    if (idToken === 'bozuk') return Promise.reject(new Error('imza gecersiz'));
    return Promise.resolve(JSON.parse(idToken) as GoogleProfile);
  }
}

function googleToken(p: Partial<GoogleProfile> & { sub: string; email: string }): string {
  return JSON.stringify({ emailVerified: true, name: 'Google Kullanici', ...p });
}

describe('AuthService (gercek PostgreSQL)', () => {
  let prisma: PrismaClient;
  let mailer: CapturingMailer;
  let clock: Date;
  let auth: AuthService;

  beforeAll(() => {
    prisma = testPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    mailer = new CapturingMailer();
    clock = new Date('2026-09-26T10:00:00Z');
    auth = new AuthService(prisma, {
      accessSecret: SECRET,
      customerAppUrl: 'http://app.test',
      mailer,
      google: new FakeGoogle(),
      now: () => clock,
    });
  });

  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  const register = (email = 'ali@test.local', password = 'gizli-sifre-1') =>
    auth.register({ email, password, fullName: 'Ali Veli' });

  describe('kayit ve giris', () => {
    it('kayit kullanici + cuzdan acar, dogrulama e-postasi gonderir, oturum dondurur', async () => {
      const session = await register();

      expect(session.user).toMatchObject({
        email: 'ali@test.local',
        emailVerified: false,
        hasPassword: true,
      });
      const user = await prisma.user.findUniqueOrThrow({
        where: { email: 'ali@test.local' },
        include: { wallet: true },
      });
      expect(user.wallet).not.toBeNull();
      expect(user.passwordHash).toMatch(/^scrypt\$/);
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]?.link).toMatch(/^http:\/\/app\.test\/verify-email\?token=/);

      const claims = await auth.verifyAccessToken(session.accessToken);
      expect(claims).toEqual({ userId: user.id, role: 'USER' });
    });

    it('ayni e-postayla ikinci kayit reddedilir', async () => {
      await register();
      await expect(register()).rejects.toBeInstanceOf(EmailTakenError);
    });

    it('dogru sifreyle giris yapilir, yanlis sifre ve olmayan hesap ayni hatayi verir', async () => {
      await register();
      await expect(
        auth.login({ email: 'ali@test.local', password: 'gizli-sifre-1' }),
      ).resolves.toBeDefined();
      await expect(
        auth.login({ email: 'ali@test.local', password: 'yanlis' }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
      await expect(auth.login({ email: 'yok@test.local', password: 'x' })).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
    });

    it('askiya alinmis hesap giris yapamaz', async () => {
      await register();
      await prisma.user.update({
        where: { email: 'ali@test.local' },
        data: { status: UserStatus.SUSPENDED },
      });
      await expect(
        auth.login({ email: 'ali@test.local', password: 'gizli-sifre-1' }),
      ).rejects.toBeInstanceOf(AccountDisabledError);
    });

    it('access token 15 dk sonra gecersizdir', async () => {
      const { accessToken } = await register();
      advance(ACCESS_TOKEN_TTL_MS + 1000);
      await expect(auth.verifyAccessToken(accessToken)).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
    });

    it('baska anahtarla imzalanmis access token reddedilir', async () => {
      const { accessToken } = await register();
      const other = new AuthService(prisma, {
        accessSecret: 'b'.repeat(40),
        customerAppUrl: 'http://app.test',
        mailer,
        google: null,
      });
      await expect(other.verifyAccessToken(accessToken)).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
    });
  });

  describe('refresh token', () => {
    it('her kullanimda dondurulur; eski token tekrar gelirse tum oturumlar kapanir', async () => {
      const first = await register();
      const second = await auth.refresh(first.refreshToken);
      expect(second.refreshToken).not.toBe(first.refreshToken);

      // Ikinci cihazdaki oturum
      const other = await auth.login({ email: 'ali@test.local', password: 'gizli-sifre-1' });

      // Calinmis eski token tekrar kullanilir
      await expect(auth.refresh(first.refreshToken)).rejects.toBeInstanceOf(UnauthenticatedError);
      await expect(auth.refresh(second.refreshToken)).rejects.toBeInstanceOf(UnauthenticatedError);
      await expect(auth.refresh(other.refreshToken)).rejects.toBeInstanceOf(UnauthenticatedError);
    });

    it('ayni token ile eszamanli iki yenilemeden yalniz biri basarili olur', async () => {
      const { refreshToken } = await register();
      const results = await Promise.allSettled([
        auth.refresh(refreshToken),
        auth.refresh(refreshToken),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('suresi dolmus token reddedilir', async () => {
      const { refreshToken } = await register();
      advance(REFRESH_TOKEN_TTL_MS + 1000);
      await expect(auth.refresh(refreshToken)).rejects.toBeInstanceOf(UnauthenticatedError);
    });

    it('cikis token i iptal eder; ikinci cikis sorun cikarmaz', async () => {
      const { refreshToken } = await register();
      await auth.logout(refreshToken);
      await auth.logout(refreshToken);
      await expect(auth.refresh(refreshToken)).rejects.toBeInstanceOf(UnauthenticatedError);
    });

    it('bilinmeyen token reddedilir', async () => {
      await expect(auth.refresh('uydurma')).rejects.toBeInstanceOf(UnauthenticatedError);
    });
  });

  describe('e-posta dogrulama', () => {
    it('baglanti hesabi dogrular ve tek kullanimliktir', async () => {
      const { user } = await register();
      const token = mailer.lastToken('EMAIL_VERIFY');
      await auth.verifyEmail(token);
      expect((await auth.getMe(user.id)).emailVerified).toBe(true);
      await expect(auth.verifyEmail(token)).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('24 saat sonra baglanti gecersizdir', async () => {
      await register();
      advance(EMAIL_VERIFY_TTL_MS + 1000);
      await expect(auth.verifyEmail(mailer.lastToken('EMAIL_VERIFY'))).rejects.toBeInstanceOf(
        InvalidTokenError,
      );
    });

    it('dogrulanmis hesaba tekrar e-posta gonderilmez', async () => {
      const { user } = await register();
      await auth.verifyEmail(mailer.lastToken('EMAIL_VERIFY'));
      await auth.resendVerification(user.id);
      expect(mailer.sent.filter((m) => m.kind === 'EMAIL_VERIFY')).toHaveLength(1);
    });
  });

  describe('sifre sifirlama', () => {
    it('yeni sifre calisir, eski sifre ve tum oturumlar gecersiz olur', async () => {
      const session = await register();
      await auth.forgotPassword('ali@test.local');
      await auth.resetPassword(mailer.lastToken('PASSWORD_RESET'), 'yeni-sifre-99');

      await expect(
        auth.login({ email: 'ali@test.local', password: 'gizli-sifre-1' }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
      const after = await auth.login({ email: 'ali@test.local', password: 'yeni-sifre-99' });
      expect(after.user.emailVerified).toBe(true);
      await expect(auth.refresh(session.refreshToken)).rejects.toBeInstanceOf(UnauthenticatedError);
    });

    it('baglanti tek kullanimlik ve 1 saat gecerlidir; yeni sifirlama eskisini iptal eder', async () => {
      await register();
      await auth.forgotPassword('ali@test.local');
      const first = mailer.lastToken('PASSWORD_RESET');
      await auth.forgotPassword('ali@test.local');
      const second = mailer.lastToken('PASSWORD_RESET');

      await auth.resetPassword(second, 'yeni-sifre-99');
      await expect(auth.resetPassword(second, 'baska-sifre-1')).rejects.toBeInstanceOf(
        InvalidTokenError,
      );
      await expect(auth.resetPassword(first, 'baska-sifre-1')).rejects.toBeInstanceOf(
        InvalidTokenError,
      );

      await auth.forgotPassword('ali@test.local');
      advance(PASSWORD_RESET_TTL_MS + 1000);
      await expect(
        auth.resetPassword(mailer.lastToken('PASSWORD_RESET'), 'x-sifre-123'),
      ).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('olmayan hesap icin sessizce doner, e-posta gondermez', async () => {
      await auth.forgotPassword('yok@test.local');
      expect(mailer.sent).toHaveLength(0);
    });
  });

  describe('Google girisi', () => {
    it('yeni kullanici acar: dogrulanmis, sifresiz, cuzdanli', async () => {
      const session = await auth.loginWithGoogle(
        googleToken({ sub: 'g-1', email: 'Ayse@Gmail.com' }),
      );
      expect(session.user).toMatchObject({
        email: 'ayse@gmail.com',
        emailVerified: true,
        hasPassword: false,
        fullName: 'Google Kullanici',
      });
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: session.user.id },
        include: { wallet: true },
      });
      expect(user.wallet).not.toBeNull();

      const again = await auth.loginWithGoogle(
        googleToken({ sub: 'g-1', email: 'ayse@gmail.com' }),
      );
      expect(again.user.id).toBe(session.user.id);
    });

    it('dogrulanmis yerel hesaba baglanir, sifre korunur', async () => {
      const local = await register('ayse@gmail.com');
      await auth.verifyEmail(mailer.lastToken('EMAIL_VERIFY'));

      const g = await auth.loginWithGoogle(googleToken({ sub: 'g-2', email: 'ayse@gmail.com' }));
      expect(g.user.id).toBe(local.user.id);
      expect(g.user.hasPassword).toBe(true);
      await expect(auth.refresh(local.refreshToken)).resolves.toBeDefined();
    });

    it('dogrulanmamis yerel hesapta sifre silinir ve eski oturumlar kapanir (hesap ele gecirme onlemi)', async () => {
      const attacker = await register('kurban@gmail.com', 'saldirgan-sifresi');

      const g = await auth.loginWithGoogle(googleToken({ sub: 'g-3', email: 'kurban@gmail.com' }));
      expect(g.user).toMatchObject({
        id: attacker.user.id,
        emailVerified: true,
        hasPassword: false,
      });
      await expect(auth.refresh(attacker.refreshToken)).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
      await expect(
        auth.login({ email: 'kurban@gmail.com', password: 'saldirgan-sifresi' }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    });

    it('e-postasi dogrulanmamis Google hesabi reddedilir', async () => {
      await expect(
        auth.loginWithGoogle(
          googleToken({ sub: 'g-4', email: 'x@gmail.com', emailVerified: false }),
        ),
      ).rejects.toBeInstanceOf(GoogleEmailNotVerifiedError);
    });

    it('gecersiz token reddedilir; Google kapaliysa anlasilir hata doner', async () => {
      await expect(auth.loginWithGoogle('bozuk')).rejects.toBeInstanceOf(InvalidTokenError);
      const noGoogle = new AuthService(prisma, {
        accessSecret: SECRET,
        customerAppUrl: 'http://app.test',
        mailer,
        google: null,
      });
      await expect(noGoogle.loginWithGoogle('x')).rejects.toBeInstanceOf(GoogleLoginDisabledError);
    });

    it('ayni Google hesabiyla eszamanli ilk giris tek kullanici acar', async () => {
      const token = googleToken({ sub: 'g-5', email: 'es@gmail.com' });
      const [a, b] = await Promise.all([auth.loginWithGoogle(token), auth.loginWithGoogle(token)]);
      expect(a.user.id).toBe(b.user.id);
      expect(await prisma.user.count({ where: { email: 'es@gmail.com' } })).toBe(1);
      expect(await prisma.authIdentity.count({ where: { providerUserId: 'g-5' } })).toBe(1);
    });
  });

  it('veritabaninda token ve sifre duz metin olarak durmaz', async () => {
    const session = await register();
    const rows = JSON.stringify([
      await prisma.refreshToken.findMany(),
      await prisma.authToken.findMany(),
      await prisma.user.findMany(),
    ]);
    expect(rows).not.toContain(session.refreshToken);
    expect(rows).not.toContain(mailer.lastToken('EMAIL_VERIFY'));
    expect(rows).not.toContain('gizli-sifre-1');
  });
});
