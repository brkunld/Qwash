# QWASH — Akilli Self-Servis Oto Yikama IoT Platformu

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![NestJS](https://img.shields.io/badge/Backend-NestJS-red.svg)](https://nestjs.com/)
[![Next.js](https://img.shields.io/badge/Frontend-Next.js%20PWA-black.svg)](https://nextjs.org/)
[![PostgreSQL](https://img.shields.io/badge/Database-PostgreSQL-336791.svg)](https://www.postgresql.org/)
[![MQTT](https://img.shields.io/badge/IoT-MQTTS%20TLS-orange.svg)](https://mqtt.org/)
[![Status](https://img.shields.io/badge/Status-Dokumantasyon%20Asamasi-yellow.svg)]()

QWASH, self-servis oto yikama istasyonlari icin tasarlanan web tabanli, IoT destekli ve finansal olarak denetlenebilir bir otomasyon platformudur.

Platformun hedefi; musterinin uygulama indirmeden QR ile perona baglanmasini, kartla bakiye yuklemesini, yikama seansini baslatmasini ve istasyon sahibinin tum operasyonu tek panelden izlemesini saglamaktir.

> Mevcut durum: Bu repo su anda mimari tasarim ve dokumantasyon asamasindadir. Uygulama kodu, monorepo paketleri ve altyapi dosyalari henuz eklenmemistir.

---

## Planlanan Yetenekler

- **Musteri PWA:** Musteri native uygulama indirmeden QR kod ile perona baglanir.
- **Tek Cuzdan & Coklu Program:** Kullanicinin tek bir TL cuzdan bakiyesi vardir (ayri ayri kredi tipleri yoktur). Her yikama programinin (Su: 0.50 TL/sn, Kopuk: 1.00 TL/sn, Cila: 1.50 TL/sn, Hava: 0.75 TL/sn) saniyelik birim fiyati admin tarafindan belirlenir ve harcanan sureye gore tek TL bakiyesinden kurus bazinda dusulur.
- **Cuzdan ve Ledger:** Bakiye hareketleri kurus bazinda ve denetlenebilir cift tarafli ledger kayitlariyla tutulur.
- **Coklu Role IoT ACK:** ESP32 uzerindeki ilgili program rolesi (su, kopuk, cila, hava) baslamadan kalici tahsilat yapilmaz.
- **Donanimsal MAC & Kolay Wi-Fi:** Her ESP32 fabrikasyon MAC adresiyle tekil kimlik kazanir (Zero-Config). Ilk acilista Captive Portal AP modu ile telefondan kolayca Wi-Fi agina baglanir.
- **Offline Fail-Safe:** Internet kopsa bile ESP32 lokal sayac ile sureyi tamamlar ve aktif roleyi kapatir.
- **Admin Dinamik Paket/Program Yonetimi:** Istasyon sahibi sifirdan yeni yikama programi (Su, Kopuk, Cila, Hava, Motor Yikama vb.) ekleyebilir, saniyelik kurus tarifesini degistirebilir, ESP32 role kanali esleyebilir veya programi kaldirabilir (Soft-Delete). ESP32 donanimi program isimlerinden bagimsiz calisir.
- **Device Twin:** Sunucu beklenen role durumu ile sahadan gelen gercek durumu anlik karsilastirir.

---

## Planlanan Mimari

```text
qwash/
├── apps/
│   ├── backend/          # NestJS API ve is mantigi
│   ├── web-customer/     # Next.js musteri PWA
│   └── web-admin/        # Next.js admin paneli
├── packages/
│   ├── contracts/        # Ortak DTO, event ve semalar
│   ├── eslint-config/    # Ortak lint konfigürasyonu
│   └── tsconfig/         # Ortak TypeScript konfigürasyonu
├── docker/               # PostgreSQL, Redis ve Mosquitto tanimlari
├── docs/                 # Muhendislik dokumantasyonu
└── package.json
```

```text
Musteri PWA / Admin Paneli
          │
          ▼
      NestJS API
          │
 ┌────────┼────────┐
 ▼        ▼        ▼
PostgreSQL Redis  MQTT Broker
                    │
                    ▼
                ESP32 Cihazlari
```

---

## Teknoloji Yonu

| Katman               | Planlanan Teknolojiler                              |
| -------------------- | --------------------------------------------------- |
| Monorepo             | Turborepo, pnpm workspaces, TypeScript              |
| Backend              | NestJS, Prisma ORM, Pino Logger                     |
| Veritabani ve Kuyruk | PostgreSQL, Redis, BullMQ                           |
| Frontend             | Next.js, React, Tailwind CSS, PWA                   |
| IoT                  | ESP32, Arduino C++, MQTT over TLS                   |
| Odeme                | Iyzico 3D Secure Checkout ve webhook reconciliation |
| DevOps               | Docker, Docker Compose, Nginx, GitHub Actions       |

---

## Dokumantasyon

- [Proje Plani](docs/PROJECT_PLAN.md): Urun vizyonu, kapsam, non-goals ve mimari sinirlar.
- [Roadmap](docs/ROADMAP.md): MVP odakli teslimat plani ve faz bazli tamamlanma kriterleri.
- [Mimari](docs/ARCHITECTURE.md): Sistem topolojisi, ledger modeli, outbox/inbox, state machine ve device twin.
- [API](docs/API.md): Planlanan REST endpointleri, cevap formati ve anlik kanallar.
- [Veritabani](docs/DATABASE.md): Planlanan PostgreSQL ve Prisma model tasarimi.
- [IoT](docs/IOT.md): ESP32, MQTT topicleri, komut payloadlari ve fail-safe davranisi.
- [Guvenlik](docs/SECURITY.md): Kimlik dogrulama, yetkilendirme, MQTT guvenligi ve odeme korumalari.
- [Test Stratejisi](docs/TESTING.md): Test yaklasimi, concurrency testleri ve ariza senaryolari.
- [Deployment](docs/DEPLOYMENT.md): Ortam modeli, CI/CD yonu ve production operasyonlari.

### Mimari Karar Kayitlari

- [ADR-0001: Modular Monolith](docs/adr/0001-modular-monolith.md)
- [ADR-0002: Kafka Yerine BullMQ](docs/adr/0002-bullmq-over-kafka.md)
- [ADR-0003: Iyzico Odeme Saglayicisi](docs/adr/0003-iyzico-payment-provider.md)
- [ADR-0004: Ledger ve Kurus Standardi](docs/adr/0004-ledger-and-money-in-kurus.md)
- [ADR-0005: Outbox ve Inbox Deseni](docs/adr/0005-outbox-inbox-pattern.md)
- [ADR-0006: Device Twin Mimarisi](docs/adr/0006-device-twin-architecture.md)
- [ADR-0007: Seans Durum Makinesi ve Two-Phase ACK](docs/adr/0007-session-state-machine-and-two-phase-ack.md)
- [ADR-0008: Once PWA, Native Sonra](docs/adr/0008-pwa-first-client-strategy.md)
- [ADR-0009: Musteri Kimlik Dogrulama](docs/adr/0009-customer-authentication.md)

---

## Yol Haritasi Ozeti

0. **Dokumantasyon ve Mimari Temel:** Kapsam, ana kararlar ve uygulama sinirlari.
1. **Monorepo Temeli:** Workspaces, ortak konfig, contracts ve lokal altyapi.
2. **Cuzdan ve Ledger Cekirdegi:** Para dogrulugu, constraint'ler, idempotency.
3. **Donanim Spike:** ESP32, role, MQTT, fail-safe (Faz 2 ile paralel yapilabilir).
4. **Seans ve IoT Entegrasyonu:** State machine, two-phase ACK, outbox/inbox, device twin, mutabakat.
5. **Odeme ve Musteri PWA:** Iyzico sandbox, webhook reconciliation, uctan uca musteri akisi.
6. **Admin Operasyonlari:** Peron izleme, bakim modu, cihaz sagligi, manuel islemler.
7. **Pilot Guclendirme:** Guvenlik gozden gecirmesi, yedekleme, gozlemlenebilirlik, yuk testleri.

Ayrintilar: [Roadmap](docs/ROADMAP.md).

---

## Baslangic

Uygulama dosyalari henuz mevcut degil. Monorepo temeli eklendikten sonra lokal kurulumun su akisla ilerlemesi planlanir:

```bash
pnpm install
docker compose -f docker/docker-compose.dev.yml up -d
pnpm dev
```

Planlanan gelistirici akisi icin [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) belgesine bakin.

---

## Lisans

.
