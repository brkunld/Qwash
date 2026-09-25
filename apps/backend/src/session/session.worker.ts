import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { MqttService } from '../iot/mqtt.service';
import type { OutboxService } from '../outbox/outbox.service';
import type { SessionService } from './session.service';

export interface WorkerIntervals {
  outboxMs: number;
  sweepMs: number;
}

/**
 * Arka plan donguleri (ADR-0010): outbox yayini ve seans taramasi.
 * Zamanlayicilar yalnizca "ne zaman bakilacagini" belirler; tum durum veritabanindadir,
 * surec yeniden baslasa da bekleyen komut ve zaman asimlari kaybolmaz.
 */
export class SessionWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SessionWorker.name);
  private timers: NodeJS.Timeout[] = [];
  private running = new Set<string>();

  constructor(
    private readonly mqtt: MqttService,
    private readonly outbox: OutboxService,
    private readonly sessions: SessionService,
    private readonly intervals: WorkerIntervals,
  ) {}

  onApplicationBootstrap(): void {
    this.mqtt.start((topic, payload) => this.sessions.handleDeviceMessage(topic, payload));
    this.every('outbox', this.intervals.outboxMs, () => this.outbox.publishPending(this.mqtt));
    this.every('sweep', this.intervals.sweepMs, () => this.sessions.sweep());
  }

  async onApplicationShutdown(): Promise<void> {
    this.timers.forEach(clearInterval);
    this.timers = [];
    await this.mqtt.close();
  }

  /** Bir tur bitmeden ayni isin ikinci turu baslamaz. */
  private every(name: string, ms: number, job: () => Promise<unknown>): void {
    this.timers.push(
      setInterval(() => {
        if (this.running.has(name)) return;
        this.running.add(name);
        job()
          .catch((err: unknown) => this.logger.error({ err }, `${name} turu basarisiz`))
          .finally(() => this.running.delete(name));
      }, ms),
    );
  }
}
