import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { AlarmService } from './alarm.service';

/** Alarm taramasini periyodik calistirir. Tum durum veritabanindadir; surec yeniden baslasa da alarm kaybolmaz. */
export class AlarmWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AlarmWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly alarms: AlarmService,
    private readonly everyMs = 30_000,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.alarms
        .sweep()
        .catch((err: unknown) => this.logger.error({ err }, 'Alarm taramasi basarisiz'))
        .finally(() => {
          this.running = false;
        });
    }, this.everyMs);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
