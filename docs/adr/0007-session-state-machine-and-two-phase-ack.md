# ADR-0007: Seans Durum Makinesi ve Two-Phase ACK Protokolü

* **Durum:** Kabul Edildi
* **Tarih:** 2026-09-17
* **Karar Veren:** Proje Lideri

---

## Bağlam

Yıkama otomasyonunda kullanıcı "Başlat" butonuna tıkladığında, bakiye düşümü ile donanımın çalışması arasındaki eşzamanlama kritik bir sorundur:

* Bakiye anında düşülürse, fakat cihaz o an elektriksiz olduğu için çalışamazsa → **haksız para kesilir**.
* Önce cihaz çalıştırılıp sonra bakiye kesilmeye çalışılırsa, bakiye yetersizliğinde → **kaçak yıkama** gerçekleşir.

## Karar

1. **Deterministik Durum Makinesi:** Seanslar rastgele durumlar yerine katı kurallara bağlı bir State Machine üzerinden ilerler:

   ```
   CREATED → RESERVED → FUNDS_HELD → START_COMMAND_SENT → RUNNING → COMPLETED
   ```

2. **Two-Phase Commit (ACK):**

   | Aşama | Eylem |
   |---|---|
   | **Aşama 1 — Hazırlık & Bloke** | Kullanıcı başlatır → Para düşülmez, `HOLD` edilir → MQTT `START` komutu gönderilir |
   | **Aşama 2 — Onay & Tahsilat** | ESP32 röleyi fiziksel çeker → `STARTED_ACK` gönderir → Bakiye `CAPTURED`, seans `RUNNING` |
   | **Zaman Aşımı / Hata** | 5 sn içinde ACK gelmezse → `RELEASED`, kullanıcıya iade, peron `ERROR` moda alınır |

## Gerekçe

| Kriter | Tek Aşamalı | Two-Phase ACK |
|---|---|---|
| Haksız para kesimi riski | Yüksek | Yok |
| Kaçak yıkama riski | Yüksek | Yok |
| Başlama gecikmesi | ~0 ms | +500-1000 ms (ACK round-trip) |
| Kullanıcı deneyimi | Anlık ama güvensiz | Frontend "Peron Başlatılıyor…" animasyonu ile çözülür |

## Sonuçlar

* Sıfır kullanıcı mağduriyeti ve sıfır kaçak yıkama — cihaz çalışmadan 1 kuruş dahi tahsil edilmez.
* Başlama süresine yaklaşık 500-1000 ms'lik bir ağ/onay gecikmesi eklenir; frontend yükleme animasyonu ile maskelenir.
* Two-Phase ACK mekanizması [ADR-0005](0005-outbox-inbox-pattern.md) Outbox/Inbox pattern'i ile entegre çalışır.
