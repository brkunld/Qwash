# QWASH — Muhendislik Dokumantasyonu

Bu dizin, planlanan QWASH self-servis oto yikama otomasyon platformunun muhendislik dokumantasyonunu icerir.

Dokumanlar; hedef mimariyi, teslimat planini, guvenlik modelini, IoT davranisini ve operasyon yaklasimini tanimlar. Uygulama dosyalari henuz repoda bulunmadigi icin bu belgeler proje temeli ve tasarim yonu olarak okunmalidir.

---

## Dokumantasyon Haritasi

| Dokuman | Amac | Hedef Okuyucu |
|---|---|---|
| [PROJECT_PLAN.md](PROJECT_PLAN.md) | Vizyon, MVP kapsami, non-goals, mimari sinirlar ve mevcut uygulama durumu. | Urun, teknik liderler |
| [ROADMAP.md](ROADMAP.md) | Dokumantasyon temelinden pilot guclendirmeye kadar fazli teslimat plani. | Tum katilimcilar |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Planlanan sistem topolojisi, ledger, state machine, outbox/inbox ve device twin. | Backend, platform, mimari |
| [API.md](API.md) | Planlanan REST endpointleri, cevap desenleri, idempotency ve anlik kanallar. | Frontend, backend |
| [DATABASE.md](DATABASE.md) | Planlanan PostgreSQL ve Prisma model tasarimi. | Backend, veritabani |
| [IOT.md](IOT.md) | ESP32 davranisi, MQTT topicleri, komut payloadlari ve fail-safe kurallari. | Embedded, backend |
| [SECURITY.md](SECURITY.md) | Kimlik dogrulama, yetkilendirme, MQTT guvenligi, odeme korumasi ve tehdit modeli. | Backend, guvenlik |
| [TESTING.md](TESTING.md) | Test stratejisi, ariza senaryolari ve concurrency dogrulamasi. | QA, backend, platform |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Planlanan lokal gelistirme akisi ve komutlari. | Gelistiriciler |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Planlanan ortam modeli, CI/CD ve production operasyonlari. | DevOps, platform |

---

## Mimari Karar Kayitlari

| ADR | Karar |
|---|---|
| [0001](adr/0001-modular-monolith.md) | Microservices yerine once modular monolith kullanilacak. |
| [0002](adr/0002-bullmq-over-kafka.md) | Ilk fazlarda Kafka yerine BullMQ/Redis kullanilacak. |
| [0003](adr/0003-iyzico-payment-provider.md) | Ilk odeme saglayicisi olarak Iyzico kullanilacak. |
| [0004](adr/0004-ledger-and-money-in-kurus.md) | Para icin ledger muhasebesi ve integer kurus standardi kullanilacak. |
| [0005](adr/0005-outbox-inbox-pattern.md) | Guvenilir yan etkiler icin outbox/inbox patternleri kullanilacak. |
| [0006](adr/0006-device-twin-architecture.md) | Cihazlarda desired ve reported state takip edilecek. |
| [0007](adr/0007-session-state-machine-and-two-phase-ack.md) | Deterministik session state machine ve two-phase ACK kullanilacak. |

---

## Temel Muhendislik Ilkeleri

1. Para integer kurus ve denetlenebilir ledger kayitlariyla yonetilir.
2. Kalici tahsilattan once cihaz dogrulamasi gerekir.
3. ESP32 cihazlari baglanti kaybi durumunda guvenli sekilde kapanabilmelidir.
4. Ilk teslimat hedefi enterprise olcek degil, calisan vertical slice'tir.
5. Dokumantasyon, planlanan mimari ile uygulanmis kodu net ayirmalidir.
