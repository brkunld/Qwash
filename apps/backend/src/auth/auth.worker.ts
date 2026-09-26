import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { AuthService } from './auth.service';

const PURGE_INTERVAL_MS = 60 * 60 * 1000;

/** Suresi dolmus giris deneme pencerelerini temizler; tablo rastgele adreslerle sismesin. */
@Injectable()
export class AuthWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AuthWorker.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly auth: AuthService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.auth
        .purgeLoginThrottles()
        .then((count) => {
          if (count) this.logger.log({ count }, 'Eski giris deneme kayitlari silindi');
        })
        .catch((err: unknown) => this.logger.error({ err }, 'Giris deneme temizligi basarisiz'));
    }, PURGE_INTERVAL_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
