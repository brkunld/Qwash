import { Prisma, PrismaClient } from '../generated/prisma/client';
import type { OutboxEvent } from '../generated/prisma/client';
import { OutboxStatus } from '../generated/prisma/enums';
import type { CommandEnvelope } from '../iot/iot.contract';
import type { Tx } from '../wallet/wallet.service';

/** MQTT'ye yayin yapan taraf. Uretimde MqttService, testlerde sahte yayinci. */
export interface MessagePublisher {
  /** QoS 1 ile yayinlar; broker PUBACK vermeden resolve etmez. */
  publish(topic: string, payload: string): Promise<void>;
}

export interface EnqueueInput {
  topic: string;
  envelope: CommandEnvelope;
  expiresAt?: Date;
  sessionId?: string;
}

export interface PublishRunResult {
  published: number;
  expired: number;
  failed: number;
}

/**
 * Transactional outbox (ADR-0005). Komutlar is kaydiyla ayni transaction'da yazilir,
 * ayri bir dongu bunlari yayinlar.
 *
 * Teslim garantisi "en az bir kez": yayin sonrasi, kayit PUBLISHED isaretlenmeden
 * surec coker ise komut tekrar gonderilir. Cihaz ayni commandId'yi ikinci kez
 * uygulamaz (firmware idempotency), bu yuzden tekrar zararsizdir.
 */
export class OutboxService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  enqueue(tx: Tx, input: EnqueueInput): Promise<OutboxEvent> {
    return tx.outboxEvent.create({
      data: {
        topic: input.topic,
        payload: input.envelope as unknown as Prisma.InputJsonValue,
        expiresAt: input.expiresAt ?? null,
        sessionId: input.sessionId ?? null,
      },
    });
  }

  /**
   * Bekleyen komutlari sirayla yayinlar. Birden fazla surec ayni anda calisabilir:
   * satirlar FOR UPDATE SKIP LOCKED ile alinir, ayni komutu iki surec yayinlamaz.
   */
  async publishPending(publisher: MessagePublisher, batchSize = 20): Promise<PublishRunResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "OutboxEvent"
          WHERE "status" = 'PENDING'
          ORDER BY "createdAt"
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED`;
        const result: PublishRunResult = { published: 0, expired: 0, failed: 0 };

        for (const { id } of rows) {
          const event = await tx.outboxEvent.findUniqueOrThrow({ where: { id } });
          const now = this.clock();

          if (event.expiresAt && event.expiresAt <= now) {
            // Gec kalmis bir START'i yayinlamak, iadesi yapilmis seansta suyu acabilir.
            await tx.outboxEvent.update({
              where: { id },
              data: { status: OutboxStatus.EXPIRED },
            });
            result.expired += 1;
            continue;
          }

          try {
            await publisher.publish(event.topic, JSON.stringify(event.payload));
            await tx.outboxEvent.update({
              where: { id },
              data: {
                status: OutboxStatus.PUBLISHED,
                publishedAt: now,
                attempts: { increment: 1 },
              },
            });
            result.published += 1;
          } catch (error) {
            await tx.outboxEvent.update({
              where: { id },
              data: { attempts: { increment: 1 }, lastError: String(error).slice(0, 500) },
            });
            result.failed += 1;
            // Broker'a ulasilamiyorsa siradakileri denemek anlamsiz; sonraki turda tekrar.
            break;
          }
        }
        return result;
      },
      { timeout: 30_000 },
    );
  }
}
