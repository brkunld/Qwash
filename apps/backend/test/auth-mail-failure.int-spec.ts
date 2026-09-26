import { AuthService } from '../src/auth/auth.service';
import { Mailer, type AuthMail } from '../src/auth/mailer';
import { PrismaClient } from '../src/generated/prisma/client';
import { resetDatabase, testPrisma } from './db';

/** Her gonderimi bekletip sonra reddeden e-posta saglayicisi (SMTP kesintisi/yavasligi). */
class DownMailer extends Mailer {
  attempts: AuthMail[] = [];
  release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async send(mail: AuthMail): Promise<void> {
    this.attempts.push(mail);
    await this.gate;
    throw new Error('SMTP kapali');
  }
}

describe('E-posta saglayicisi coktugunde (gercek PostgreSQL)', () => {
  let prisma: PrismaClient;
  let mailer: DownMailer;
  let auth: AuthService;

  beforeAll(() => {
    prisma = testPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    mailer = new DownMailer();
    auth = new AuthService(prisma, {
      accessSecret: 'test-secret-that-is-at-least-32-chars!!',
      customerAppUrl: 'http://app.test',
      mailer,
      google: null,
    });
  });

  const REGISTER = { email: 'ali@test.com', password: 'gizli-sifre-1', fullName: 'Ali Veli' };

  it('kayit gonderimi beklemez ve basarili doner; hata istemciye yansimaz', async () => {
    // Saglayici hic cevap vermese de (kapi acilmadi) kayit tamamlanir.
    const session = await auth.register(REGISTER);
    expect(session.user.email).toBe('ali@test.com');
    expect(mailer.attempts).toHaveLength(1);
    expect(mailer.attempts[0]).toMatchObject({ kind: 'EMAIL_VERIFY', to: 'ali@test.com' });
    // Simdi saglayici hata versin: yakalanmamis reddedilme (unhandled rejection) olmamali.
    mailer.release();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('sifremi unuttum: hesap varken de yokken de ayni sekilde ve gonderimi beklemeden doner', async () => {
    await auth.register(REGISTER);
    mailer.attempts = [];

    const started = Date.now();
    await auth.forgotPassword('ali@test.com'); // hesap var, saglayici takili
    await auth.forgotPassword('yok@test.com'); // hesap yok
    expect(Date.now() - started).toBeLessThan(2_000);
    // Yalniz var olan hesap icin gonderim denendi.
    expect(mailer.attempts.map((m) => `${m.kind}:${m.to}`)).toEqual([
      'PASSWORD_RESET:ali@test.com',
    ]);
    mailer.release();
    await new Promise((r) => setTimeout(r, 50));
  });
});
