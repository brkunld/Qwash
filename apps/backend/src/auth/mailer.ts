import { Logger } from '@nestjs/common';

// E-posta gonderimi. Saglayici (SMTP/Resend/SES) henuz secilmedi; secilince bu
// arayuzun bir uygulamasi eklenir. O zamana kadar production'da uygulama baslamaz.

export interface AuthMail {
  to: string;
  kind: 'EMAIL_VERIFY' | 'PASSWORD_RESET';
  link: string;
}

export abstract class Mailer {
  abstract send(mail: AuthMail): Promise<void>;
}

/** Gelistirme: baglantiyi konsola yazar. Yalniz NODE_ENV=development'ta kullanilir. */
export class DevConsoleMailer extends Mailer {
  private readonly logger = new Logger('DevMailer');

  send(mail: AuthMail): Promise<void> {
    this.logger.warn(`[DEV e-posta] ${mail.kind} -> ${mail.to}: ${mail.link}`);
    return Promise.resolve();
  }
}

/** Testler: gonderilen e-postalari bellekte tutar. */
export class CapturingMailer extends Mailer {
  readonly sent: AuthMail[] = [];

  send(mail: AuthMail): Promise<void> {
    this.sent.push(mail);
    return Promise.resolve();
  }

  /** Son gonderilen e-postadaki token'i dondurur. */
  lastToken(kind: AuthMail['kind']): string {
    const mail = [...this.sent].reverse().find((m) => m.kind === kind);
    if (!mail) throw new Error(`${kind} e-postasi gonderilmedi`);
    const token = new URL(mail.link).searchParams.get('token');
    if (!token) throw new Error('Baglantida token yok');
    return token;
  }
}
