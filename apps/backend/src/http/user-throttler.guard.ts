import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Hiz siniri girisli istekte kullanici basina, girissizde IP basina sayilir (API.md 6).
 * Istasyondaki musteriler mobil operator NAT'i arkasinda ayni IP'yi paylasabilir;
 * IP basina sinir birinin denemesini digerine yazardi.
 *
 * Global guard, AccessTokenGuard'dan once calisir; bu yuzden token dogrulanmadan
 * ozeti kullanilir. Dogrulanmamis "sub" kullanilmaz: taklit edilip baskasinin kotasi
 * tuketilebilirdi. Gecersiz token zaten 401 alir.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const header = (req.headers as Record<string, unknown> | undefined)?.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const digest = createHash('sha256').update(header.slice(7).trim()).digest('hex');
      return `token:${digest.slice(0, 32)}`;
    }
    return super.getTracker(req);
  }
}
