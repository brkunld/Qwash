import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { SESSION_CHANNEL } from '../session/session.service';

/**
 * PostgreSQL LISTEN ile commit edilmis seans degisikliklerini dinler (Faz 5c).
 *
 * Bildirim, degisikligi yapan surec hangisi olursa olsun (API, MQTT isleyicisi, tarama,
 * baska bir backend kopyasi) tum dinleyicilere ulasir. Baglanti koparsa yeniden kurulur;
 * aradaki bildirimler kaybolur, bu yuzden yeniden baglaninca onReconnect cagrilir
 * (istemciler zaten REST ile durumu geri yukleyebilir).
 */
export class SessionChangeListener {
  private readonly logger = new Logger(SessionChangeListener.name);
  private client: Client | null = null;
  private closed = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private onChange: (sessionId: string) => void = () => {};
  private onReconnect: () => void = () => {};

  constructor(
    private readonly databaseUrl: string,
    private readonly retryMs = 2_000,
  ) {}

  bind(onChange: (sessionId: string) => void, onReconnect: () => void): void {
    this.onChange = onChange;
    this.onReconnect = onReconnect;
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.connect(false);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }

  private async connect(isRetry: boolean): Promise<void> {
    const client = new Client({ connectionString: this.databaseUrl });
    client.on('notification', (msg) => {
      if (msg.channel === SESSION_CHANNEL && msg.payload) this.onChange(msg.payload);
    });
    client.on('error', (err) => {
      this.logger.warn({ err }, 'Seans bildirim baglantisi koptu');
      this.scheduleRetry(client);
    });
    client.on('end', () => this.scheduleRetry(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${SESSION_CHANNEL}`);
    } catch (err) {
      if (!isRetry) throw err;
      this.logger.warn({ err }, 'Seans bildirim baglantisi kurulamadi; tekrar denenecek');
      this.scheduleRetry(client);
      return;
    }
    if (this.closed) {
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
    if (isRetry) {
      this.logger.log('Seans bildirim baglantisi yeniden kuruldu');
      this.onReconnect();
    }
  }

  private scheduleRetry(failed: Client): void {
    if (this.closed || this.retryTimer) return;
    if (this.client && this.client !== failed) return;
    this.client = null;
    failed.end().catch(() => undefined);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect(true);
    }, this.retryMs);
  }
}
