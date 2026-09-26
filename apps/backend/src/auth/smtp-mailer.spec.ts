import type { Transporter } from 'nodemailer';
import { renderMail, SmtpMailer } from './smtp-mailer';

const LINK = 'https://app.test/reset-password?token=abc123';

function fakeTransport(): { transport: Transporter; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const transport = {
    sendMail: (m: Record<string, unknown>) => {
      sent.push(m);
      return Promise.resolve({});
    },
  } as unknown as Transporter;
  return { transport, sent };
}

describe('renderMail', () => {
  it('sifre sifirlama: Turkce konu, baglanti duz metinde ve HTML dugmesinde', () => {
    const m = renderMail({ to: 'a@b.test', kind: 'PASSWORD_RESET', link: LINK });
    expect(m.subject).toBe('QWash şifre sıfırlama');
    expect(m.text).toContain(LINK);
    expect(m.html).toContain(`href="${LINK}"`);
    expect(m.text).toContain('1 saat');
    expect(m.text).toContain('yok sayabilirsiniz');
  });

  it('e-posta dogrulama: 24 saat gecerlilik bilgisi', () => {
    const m = renderMail({ to: 'a@b.test', kind: 'EMAIL_VERIFY', link: LINK });
    expect(m.subject).toBe('QWash e-posta adresinizi doğrulayın');
    expect(m.text).toContain('24 saat');
  });

  it('baglantidaki ozel karakterler HTML icinde kacirilir', () => {
    const m = renderMail({
      to: 'a@b.test',
      kind: 'EMAIL_VERIFY',
      link: 'https://app.test/x?a=1&b="><script>alert(1)</script>',
    });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&amp;b=&quot;&gt;&lt;script&gt;');
  });
});

describe('SmtpMailer', () => {
  it('yapilandirilan gonderenle, alici ve icerikle gonderir', async () => {
    const { transport, sent } = fakeTransport();
    const mailer = new SmtpMailer(
      { host: 'smtp.test', port: 587, secure: false, from: 'QWash <no-reply@qwash.test>' },
      transport,
    );
    await mailer.send({ to: 'musteri@test.com', kind: 'PASSWORD_RESET', link: LINK });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: 'QWash <no-reply@qwash.test>',
      to: 'musteri@test.com',
      subject: 'QWash şifre sıfırlama',
    });
  });

  it('tasiyici hata verirse send reddedilir (cagiran karar verir)', async () => {
    const transport = {
      sendMail: () => Promise.reject(new Error('SMTP baglanti hatasi')),
    } as unknown as Transporter;
    const mailer = new SmtpMailer(
      { host: 'smtp.test', port: 587, secure: false, from: 'no-reply@qwash.test' },
      transport,
    );
    await expect(mailer.send({ to: 'a@b.test', kind: 'EMAIL_VERIFY', link: LINK })).rejects.toThrow(
      'SMTP baglanti hatasi',
    );
  });
});
