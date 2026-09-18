# ADR-0002: BullMQ + Redis Outbox (Kafka/RabbitMQ Yerine)

* **Durum:** Kabul Edildi
* **Tarih:** 2026-09-17
* **Karar Veren:** Proje Lideri

---

## Bağlam

QWASH'ın IoT komut yayıncısı (Outbox Worker), MQTT broker ile güvenilir mesaj teslimatı sağlamalıdır. Bu için bir mesajlaşma/kuyruk altyapısı gereklidir. Değerlendirilen alternatifler:

1. **Apache Kafka** — Dağıtık event streaming platformu
2. **RabbitMQ** — Klasik mesaj kuyruğu broker'ı
3. **BullMQ + Redis + PostgreSQL Outbox** — Redis tabanlı kuyruk + DB güvencesi

## Karar

**BullMQ + PostgreSQL Transactional Outbox** kombinasyonu seçilmiştir.

## Gerekçe

| Kriter | Kafka | RabbitMQ | BullMQ + Outbox |
|---|---|---|---|
| Operasyonel yük | Çok yüksek (ZooKeeper/KRaft) | Orta | Düşük (Redis zaten mevcut) |
| Finansal güvence | Outbox pattern ayrıca gerekir | Outbox pattern ayrıca gerekir | Outbox PostgreSQL transaction ile entegre |
| Gecikme (latency) | ms altı | ms altı | ms altı |
| Öğrenme eğrisi | Yüksek | Orta | Düşük |
| V1 iş yükü uyumu | Aşırı boyutlu | Yeterli | Tam uyumlu |

Kafka'nın güçlü yönleri (event sourcing, replay, consumer group) V1'de ihtiyaç duyulmayan özelliklerdir. Redis zaten cache ve Redlock için monorepo'da kullanıldığından ek altyapı gerekmez.

## Sonuçlar

* `OutboxEvent` tablosu PostgreSQL'de tutulur.
* BullMQ worker her 500ms'de `PENDING` olayları çeker ve MQTT'ye publish eder.
* Kafka geçişi gerekirse `OutboxEvent` tablosu event store görevi görecek şekilde tasarlanmıştır.
