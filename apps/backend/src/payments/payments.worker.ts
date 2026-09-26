import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { PaymentsService } from './payments.service';

const RECONCILE_INTERVAL_MS = 60_000;

/** Mutabakat: callback/webhook kaybolsa bile yuklemeler Iyzico'ya sorularak sonuclanir. */
@Injectable()
export class PaymentsWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentsWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly payments: PaymentsService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.payments
        .reconcile()
        .then((r) => {
          if (r.checked || r.abandoned || r.reversalsRetried) {
            this.logger.log(r, 'Kart yukleme mutabakati');
          }
        })
        .catch((err: unknown) => this.logger.error({ err }, 'Kart yukleme mutabakati basarisiz'))
        .finally(() => {
          this.running = false;
        });
    }, RECONCILE_INTERVAL_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
