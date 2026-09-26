import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { EMAIL_VERIFY_TTL_MS, PASSWORD_RESET_TTL_MS } from './auth.service';
import { Mailer, type AuthMail } from './mailer';

export interface SmtpOptions {
  host: string;
  port: number;
  /** true: baglanti baslangicta TLS (465). false: STARTTLS (587). */
  secure: boolean;
  user?: string;
  password?: string;
  /** Gonderen: `QWash <adres@alan.com>` veya yalniz adres. */
  from: string;
}

interface Template {
  subject: string;
  intro: string;
  action: string;
  validity: string;
}

const HOURS = (ms: number) => Math.round(ms / 3_600_000);

const TEMPLATES: Record<AuthMail['kind'], Template> = {
  EMAIL_VERIFY: {
    subject: 'QWash e-posta adresinizi doğrulayın',
    intro: 'QWash hesabınızı oluşturduğunuz için teşekkürler. E-posta adresinizi doğrulamak için:',
    action: 'E-postamı doğrula',
    validity: `Bağlantı ${HOURS(EMAIL_VERIFY_TTL_MS)} saat geçerlidir.`,
  },
  PASSWORD_RESET: {
    subject: 'QWash şifre sıfırlama',
    intro: 'QWash hesabınız için şifre sıfırlama isteği aldık. Yeni şifre belirlemek için:',
    action: 'Şifremi sıfırla',
    validity: `Bağlantı ${HOURS(PASSWORD_RESET_TTL_MS)} saat geçerlidir ve yalnızca bir kez kullanılabilir.`,
  },
};

const IGNORE =
  'Bu isteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz; hesabınızda bir değişiklik olmaz.';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Ic kullanim ve testler icin: sablondan konu/duz metin/HTML uretir. */
export function renderMail(mail: AuthMail): { subject: string; text: string; html: string } {
  const t = TEMPLATES[mail.kind];
  const text = `${t.intro}\n\n${mail.link}\n\n${t.validity}\n${IGNORE}\n\nQWash`;
  const link = escapeHtml(mail.link);
  const html = `<!doctype html><html lang="tr"><body style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.5">
<p>${escapeHtml(t.intro)}</p>
<p><a href="${link}" style="display:inline-block;background:#fa9a09;color:#0f172a;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:10px">${escapeHtml(t.action)}</a></p>
<p style="font-size:13px;color:#475569">Düğme çalışmazsa bu adresi tarayıcınıza yapıştırın:<br>${link}</p>
<p style="font-size:13px;color:#475569">${escapeHtml(t.validity)}<br>${escapeHtml(IGNORE)}</p>
<p style="font-size:13px;color:#475569">QWash</p>
</body></html>`;
  return { subject: t.subject, text, html };
}

/**
 * SMTP ile gonderim. Saglayicidan bagimsizdir: Gmail (uygulama sifresi), Brevo, Resend,
 * SES SMTP arayuzu vb. yalniz ortam degiskenleriyle degisir.
 */
export class SmtpMailer extends Mailer {
  private readonly logger = new Logger(SmtpMailer.name);
  private readonly transport: Transporter;

  /** `transport` testlerde sahte tasiyici vermek icindir. */
  constructor(
    private readonly options: SmtpOptions,
    transport?: Transporter,
  ) {
    super();
    this.transport =
      transport ??
      createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure,
        auth: options.user ? { user: options.user, pass: options.password } : undefined,
        // Asili baglanti istegi bekletmesin; hatalar arka planda loglanir.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        // Sertifika dogrulamasi kapatilmaz.
        requireTLS: !options.secure,
      });
  }

  async send(mail: AuthMail): Promise<void> {
    const { subject, text, html } = renderMail(mail);
    await this.transport.sendMail({ from: this.options.from, to: mail.to, subject, text, html });
    // Alici adresi ve baglanti (token) loga yazilmaz.
    this.logger.log(`E-posta gonderildi (${mail.kind})`);
  }
}
