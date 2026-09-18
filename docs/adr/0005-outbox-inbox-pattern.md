# ADR-0005: Transactional Outbox ve Idempotent Inbox Pattern

* **Durum:** Kabul Edildi
* **Tarih:** 2026-09-17
* **Karar Veren:** Proje Lideri

---

## Bağlam

Seans başlatıldığında sistem hem PostgreSQL veritabanına kayıt yazmak hem de MQTT broker üzerinden ESP32 cihazına komut göndermek zorundadır.

Klasik yaklaşımda DB'ye yazdıktan hemen sonra doğrudan `mqttClient.publish()` çağrıldığında, ağ kopması veya sunucu çökmesi durumunda DB güncellenir ancak MQTT mesajı gönderilemez (**Dual-Write Problemi**). Sonuçta kullanıcının parası bloke olur ama cihaz çalışmaz.

Benzer şekilde, MQTT QoS 1 seviyesinde aynı komut veya ACK paketi ağ gecikmelerinde mükerrer (duplicate) olarak teslim edilebilir.

## Karar

1. **Transactional Outbox:** MQTT komutları doğrudan gönderilmez; seans kaydıyla aynı PostgreSQL transaction'ı içinde `OutboxEvent` tablosuna INSERT edilir. Ayrı bir asenkron worker bu kayıtları okuyup MQTT broker'a aktarır.
2. **Idempotent Inbox:** ESP32'den gelen her ACK ve telemetri mesajı benzersiz bir `commandId (UUID)` taşır. Backend mesajı işlemeden önce `InboxMessage` tablosunda arar; daha önce işlenmişse mükerrer işlemi yoksayar.

## Gerekçe

| Kriter | Doğrudan publish() | Outbox/Inbox Pattern |
|---|---|---|
| Dual-Write güvencesi | Yok (crash riski) | Var (aynı transaction) |
| Mükerrer komut riski | Yüksek | Yok (idempotency key) |
| Operasyonel karmaşıklık | Düşük | Orta (ek tablolar + worker) |
| Guaranteed Delivery | Yok | Var |

## Sonuçlar

* Sistem çökse bile hiçbir IoT komutu kaybolmaz (Guaranteed Delivery).
* Mükerrer komut çalıştırma riski sıfırlanır.
* Veritabanında ek iki tablo (`OutboxEvent`, `InboxMessage`) ve periyodik temizlik/arşivleme gerektirir.
* BullMQ worker her 500ms'de `PENDING` olayları çeker ve MQTT'ye publish eder (bkz. [ADR-0002](0002-bullmq-over-kafka.md)).
