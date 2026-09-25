import { Logger } from '@nestjs/common';
import { connect, type MqttClient } from 'mqtt';
import type { MessagePublisher } from '../outbox/outbox.service';
import { DEVICE_SUBSCRIPTIONS } from './iot.contract';

export type DeviceMessageHandler = (topic: string, payload: string) => Promise<unknown>;

/**
 * Broker baglantisi: komut yayinlar (QoS 1) ve cihaz topic'lerini dinler.
 *
 * Baglanti uygulamanin acilisini bloklamaz; broker yoksa mqtt.js arka planda yeniden
 * dener. O sirada yayin hata verir, outbox kaydi PENDING kalir ve sonraki turda tekrar
 * denenir; ACK alinamayan seanslar zaman asimiyla iade edilir.
 */
/** Loglarda MQTT_URL icindeki sifreyi gizler. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<gecersiz MQTT_URL>';
  }
}

export class MqttService implements MessagePublisher {
  private readonly logger = new Logger(MqttService.name);
  private client: MqttClient | null = null;

  constructor(
    private readonly url: string,
    private readonly clientId: string,
  ) {}

  start(onMessage: DeviceMessageHandler): void {
    const client = connect(this.url, {
      clientId: this.clientId,
      clean: false, // Kisa kopmalarda broker QoS 1 mesajlarini bizim icin saklar
      reconnectPeriod: 2_000,
      connectTimeout: 5_000,
    });
    this.client = client;

    client.on('connect', () => {
      client.subscribe(DEVICE_SUBSCRIPTIONS, { qos: 1 }, (err) => {
        if (err) this.logger.error(`MQTT abonelik hatasi: ${err.message}`);
        else this.logger.log(`MQTT baglandi ve dinliyor: ${redactUrl(this.url)}`);
      });
    });
    client.on('reconnect', () => this.logger.warn('MQTT yeniden baglaniyor'));
    client.on('error', (err) => this.logger.error(`MQTT hatasi: ${err.message}`));

    // Mesajlar sirayla islenir: ayni seansin ACK ve bitis mesaji ters sirada uygulanmaz.
    let chain = Promise.resolve();
    client.on('message', (topic, payload) => {
      chain = chain
        .then(() => onMessage(topic, payload.toString('utf8')))
        .then(
          (outcome) => this.logger.debug({ topic, outcome }, 'Cihaz mesaji islendi'),
          (err: unknown) => this.logger.error({ topic, err }, 'Cihaz mesaji islenemedi'),
        );
    });
  }

  async publish(topic: string, payload: string): Promise<void> {
    if (!this.client?.connected) throw new Error('MQTT bagli degil');
    await this.client.publishAsync(topic, payload, { qos: 1 });
  }

  async close(): Promise<void> {
    await this.client?.endAsync();
    this.client = null;
  }
}
