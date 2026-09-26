# QWASH — IoT & Hardware Architecture (ESP32)

Bu doküman, peronlarda çalışan ESP32 gömülü sisteminin haberleşme protokolünü, donanım mimarisini ve arıza tolerans (fail-safe) kurallarını açıklar.

---

## 1. Donanım Özellikleri & Bileşenler

- **Donanımsal Kimlik (MAC Adresi):** `WiFi.macAddress()` üzerinden okunan donanımsal MAC adresi (örn: `246F28ABCDEF`) cihazın tekil kodu (`deviceId`) olarak kullanılır. Elle kod içine seri no yazılmaz (Zero-Config Provisioning).
- **Wi-Fi Kurulumu (Captive Portal / AP Modu):** Cihaz ilk kez açıldığında veya kayıtlı Wi-Fi ağına bağlanamadığında otomatik olarak `QWASH-AP-<MAC>` adında bir erişim noktası (Access Point) açar. Teknisyen/işletmeci telefondan bu ağa bağlanarak web arayüzü üzerinden istasyonun Wi-Fi adı ve şifresini girer; ayarlar ESP32'nin kalıcı NVS belleğine kaydedilir.
- **Mikrodenetleyici:** ESP32 WROOM-32 / WROVER (Çift Çekirdek 240MHz, Wi-Fi 802.11 b/g/n, Flash FS / NVS).
- **Ekran:** Dokunmatik SPI TFT LCD (2.8" / 3.2", `TFT_eSPI` kütüphanesi). Kurulu cihazda dokunmatik ekran mevcuttur.
- **Kullanıcı Arayüzü (MVP):** Ekran iki durumda çalışır:
  - **Boşta (`IDLE`):** Peron QR kodu (yalnızca QWASH alan adına giden `bayCode` içeren adres, cihaz tarafından üretilir) ve altında kısa peron kodu/numarası.
  - **Seans sırasında:** Yalnızca **kalan süre** ve kısa durum metni (`ÇALIŞIYOR`, `BİTTİ`, `HATA`).
  - Dokunmatik giriş MVP'de kullanılmaz; seans başlatma/durdurma müşteri PWA'sından yapılır.
- **Neden basılı QR etiketi değil:** Basılı etiketin üzerine sahte bir QR yapıştırılarak müşteri sahte bir siteye yönlendirilebilir (QR-jacking). QR ekranda gösterildiğinde üzerine etiket yapıştırmak süre/QR görünümünü de kapatır ve hemen fark edilir. PWA tarafında ek olarak "Peron X'e bağlanıyorsunuz" onay adımı vardır.
- **Kullanıcı Arayüzü (sonraya):** Dönen (rotating) QR (fiziksel bulunmayı kanıtlar, uzaktan rezervasyonu zorlaştırır), fiziksel "İptal" düğmesi, program adı gösterimi. Dokunmatik ekran sayesinde donanım değişikliği gerekmez.
- **Süre kaynağı:** Ekrandaki geri sayım ESP32'nin yerel sayacından gelir (bkz. bölüm 5/6); sunucu bağlantısı kopsa da ekran ve röle tutarlı kalır.
- **Çıkışlar:** Optokuplör yalıtımlı 4 Kanal 220V 10A Röle Kartı (Röle 1: Basınçlı Su, Röle 2: Aktif Köpük, Röle 3: Sıcak Cila, Röle 4: Hava / Kurutma).
- **Geri Bildirim:** Piezo Buzzer (Geri sayım bip tonları, seans bitiş alarmı).
- **Güvenlik Donanımı:** Hardware Watchdog Timer (WDT - 15 saniye zaman aşımı).

---

## 2. MQTT Güvenlik & Ağ Seviyeleri (Security Tiers)

- **Geliştirme Ortamı (Development):**
  - Protokol: MQTT (Plaintext)
  - Port: `1883` (Standart MQTT), `9001` (Browser WebSocket)
  - Yetkilendirme: Yerel kullanıcı adı / şifre veya geliştirme ACL tanımları.

- **Canlı / Üretim Ortamı (Production):**
  - Protokol: MQTTS (TLS 1.3 zorunlu)
  - Port: `8883`
  - Yetkilendirme: Karşılıklı TLS (mTLS) ve X.509 Cihaz Sertifikası (`certificateFingerprint`).
  - Cihaz bazlı yetkilendirme (Mosquitto dynamic security / ACL): Cihaz yalnızca kendi `stationId` ve `bayId` hiyerarşisine erişebilir.

---

## 3. MQTT Topic Hiyerarşisi & Kapsamlı Erişim (ACL)

> **Uygulama (geliştirme, 2026-09-26):** Anonim bağlantı kapalı. Kullanıcılar: `qwash-backend` (`qwash/#`), `qwash-health` (yalnız `$SYS/broker/uptime`) ve her cihaz için `deviceId` (MAC). Cihaz yalnızca kendi peronunun `cmd` topic'ini okur, `ack/status/heartbeat/telemetry/events` topic'lerine yazar; başka peron adına yayın broker'da düşer. Tanımlar `docker/mosquitto/acl`, şifreler `.env` → `pnpm mqtt:credentials`. Cihazlar TLS (host 18883, geliştirme CA'sı `pnpm mqtt:certs`) ile bağlanır; düz MQTT (11883) yalnızca 127.0.0.1'de, backend için. Production'da gerçek sertifika ve backend'in de TLS kullanması gerekir.

Her ESP32 cihazı yalnızca kendi istasyon ve peronuna ait topic'leri dinleyebilir ve yayınlayabilir (Yetkisiz dinleme ve spoofing engellenir):

| Topic                                           | Yön             | QoS | İçerik                                                             |
| ----------------------------------------------- | --------------- | --- | ------------------------------------------------------------------ |
| `qwash/station/:stationId/bay/:bayId/cmd`       | Backend ➔ ESP32 | 1   | Çalıştırma (`START`), durdurma (`STOP`), reset komutları           |
| `qwash/station/:stationId/bay/:bayId/ack`       | ESP32 ➔ Backend | 1   | Komut alındı ve uygulandı teyitleri (`STARTED_ACK`, `STOPPED_ACK`) |
| `qwash/station/:stationId/bay/:bayId/status`    | ESP32 ➔ Backend | 1   | Cihaz durum güncellemeleri (`ONLINE`, `BUSY`, `ERROR`)             |
| `qwash/station/:stationId/bay/:bayId/heartbeat` | ESP32 ➔ Backend | 0   | Canlılık sinyali (RSSI, voltaj, uptime, firmware)                  |
| `qwash/station/:stationId/bay/:bayId/telemetry` | ESP32 ➔ Backend | 0   | Anlık akım/güç ölçümü, su akış sensörü verileri                    |
| `qwash/station/:stationId/bay/:bayId/events`    | ESP32 ➔ Backend | 1   | Fiziksel buton basımı, acil durdurma, WDT reset olayları           |

---

## 4. Ortak Mesaj Zarfları (Envelopes) & Idempotent Şemalar

Tüm komut ve olaylar kurumsal standartlarda ortak bir zarf (envelope) yapısına sahiptir:

### A. Komut Zarfı (`CommandEnvelope`) (Backend ➔ ESP32)

```json
{
  "commandId": "a7b3c2d1-0001-4000-8000-123456789abc",
  "sessionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "deviceId": "DEV-ESP32-BAY-001",
  "timestamp": "2026-09-17T01:30:00.000Z",
  "expiresAt": "2026-09-17T01:30:10.000Z",
  "payload": {
    "type": "START",
    "program": "WATER",
    "relayIndex": 1,
    "durationSec": 120
  }
}
```

### B. Olay / Onay Zarfı (`EventEnvelope`) (ESP32 ➔ Backend)

```json
{
  "eventId": "b8c4d3e2-0002-4000-8000-987654321def",
  "deviceId": "DEV-ESP32-BAY-001",
  "stationId": "STATION-01",
  "bayId": "BAY-001",
  "timestamp": "2026-09-17T01:30:01.200Z",
  "payload": {
    "type": "STARTED_ACK",
    "commandId": "a7b3c2d1-0001-4000-8000-123456789abc",
    "sessionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "status": "SUCCESS",
    "activeProgram": "WATER",
    "activeRelayIndex": 1,
    "relayState": "ON"
  }
}
```

### C. Diğer Kritik Payload Tipleri

- **`StopCommandPayload`:** `reason` (`USER_STOP`, `ACK_TIMEOUT`, `LATE_ACK`, `ADMIN_OVERRIDE`). Cihaz STOP'u yalnizca zarftaki `sessionId` aktif seansla eslesirse uygular; bos `sessionId` (servis/admin) aktif seansi her durumda durdurur (ADR-0010).
- **`StopAckPayload`:** `commandId`, `sessionId`, `stoppedAt`, `remainingSec`.
- **`HeartbeatPayload`:** `rssi`, `supplyVoltage`, `uptimeSec`, `firmwareVersion`, `heapFree`.
- **`TelemetryPayload`:** `flowRateLpm`, `waterPressureBar`, `currentAmps`.
- **`ErrorEventPayload`:** `errorCode`, `errorMessage`, `hardwareWatchdogFired`, `relayState`.
- **`DeviceStatusPayload`:** `status` (`ONLINE`, `OFFLINE`, `BUSY`, `ERROR`, `MAINTENANCE`).

### D. Dokunmatik Ekran Menüsü (ADR-0012)

Müşteri QR'ı okutup telefonda onaylayınca peron ekranı kısa süre onun hesabına bağlanır; paket ve süre dokunmatikten seçilir. Cihaz yalnız seçimi bildirir, tutar ve seans kararı backend'dedir.

Backend ➔ ESP32 (`cmd`, zarfta `sessionId` boş; cihaz bu komutları `commandId` halkasına yazmaz):

- **`SHOW_MENU`:** `claimId`, `timeoutSec` (göreli; cihaz saati senkron olmayabilir), `afterSession` (seans yeni bitti, "tekrar seç"), `holder` (maskeli e-posta), `availableKurus`, `programs[]` (`code`, `label` ASCII/BÜYÜK, `pricePerSecondKurus`), `durationsSec[]` (hazır süre düğmeleri). Seans sürerken gelirse bekletilir, seans bitince açılır.
- **`SHOW_QR`:** `claimId`. Bağ kapandı (müşteri bıraktı / süre doldu); ekran QR'a döner.
- **`MENU_ERROR`:** `claimId`, `message` (kısa ASCII, ör. `BAKIYE YETERSIZ`). Seçim reddedildi, seans açılmadı; bağ 30 sn uzar.

ESP32 ➔ Backend (`events`):

- **`MENU_START`:** `claimId`, `programCode`, `durationSec`, `requestId` (seçim başına; aynı seçim tekrar gönderilirse aynı kalır, ikinci seans açılmaz). Başarılıysa normal `START` komutu gelir.
- **`MENU_EXIT`:** `claimId`. Ekrandaki "Çıkış"; bağ kapanır.
- Ekrandaki **DURDUR** ayrı olay değildir: cihaz röleyi hemen kapatır ve `SESSION_ENDED` (`reason: SCREEN_STOP`, `remainingSec`) gönderir; yalnız kullanılan süre tahsil edilir.

Süreler: ilk seçim 90 sn, seans bitince 30 sn, sonra ekran QR'a döner (backend taraması ve cihaz sayacı birlikte).

---

### E. Uzaktan Ayar ve Firmware Güncellemesi (ADR-0013)

- **`DEVICE_STATUS.qrBase`** (0.7.0+): cihazın kullandığı QR taban adresi.
- **`SET_CONFIG`** (Backend ➔ ESP32): `qrBase`. Backend, bildirilen adres istenenden (`DEVICE_QR_BASE` / `<CUSTOMER_APP_URL>/b/`) farklıysa gönderir; cihaz doğrular, NVS'e yazar, durumunu yeniden bildirir.
- **`OTA`** (Backend ➔ ESP32): `updateId`, `version`, `url` (tek seferlik indirme anahtarı içerir), `sha256`, `sizeBytes`, `signature` (ECDSA P-256, DER, base64). Seans veya ekran bağı varken reddedilir (`BUSY`). Aynı sürüm tekrar gelirse yok sayılır.
- **`OTA_STATUS`** (ESP32 ➔ Backend, `events`): `updateId`, `status` (`DOWNLOADING` / `REBOOTING` / `SUCCEEDED` / `FAILED`), `detail` (Örn: `SIGNATURE`, `SHA256`, `BUSY`, `ROLLED_BACK`, `HTTP_404`).
- Güncelleme sırasında cihaz `DEVICE_STATUS: UPDATING` bildirir; peron kullanılamaz görünür. Yeni sürüm 60 sn MQTT'ye bağlı çalışınca `SUCCEEDED`; 3 açılışta bu sağlanamazsa eski sürüme döner.

---

## 5. Two-Phase ACK Protokolü (İki Aşamalı Başlatma)

> [!NOTE]
> **Timeout Katmanları — WDT (15 sn) ile ACK Timeout (10 sn) Farkı:**
>
> - **10 saniyelik ACK Timeout (Backend):** Backend, `START` komutu gönderdikten sonra ESP32'den `STARTED_ACK` bekler. Bu süre içinde yanıt gelmezse backend işlemi iptal eder ve parayı iade eder. Bu, _ağ veya cihaz başlatma arızasına_ karşı finansal güvencedir.
> - **15 saniyelik WDT (ESP32 Donanım):** Bu, ESP32'nin kendi işlemcisinin donup donmadığını denetleyen bir donanım mekanizmasıdır. Eğer ESP32 yazılımı 15 saniye boyunca WDT'yi beslemezse (watchdog kick), işlemci sıfırlanır ve NVS'deki seans verisi üzerinden kurtarma başlar. Bu, _donanım kilenmelerine_ karşı son güvencedir. İki timeout farklı katmanlarda çalışır ve birbirini tamamlar.

1. Backend, cüzdandan parayı henüz kalıcı düşmeden `HOLD` eder.
2. Backend MQTT üzerinden `START` komutunu publish eder ve 10 saniyelik bir bekleme başlatır.
3. ESP32 komutu alır, `commandId`'yi daha önce çalıştırıp çalıştırmadığını NVS/RAM'den kontrol eder (idempotency).
4. ESP32 röleyi fiziksel olarak çeker ve derhal `STARTED_ACK` yayınlar.
5. Backend `STARTED_ACK` mesajını aldığı anda seansı `RUNNING` yapar ve bakiyeyi `CAPTURED` eder.
6. **Arıza Senaryosu:** Eğer 10 saniye içinde ACK gelmezse (cihaz kapalı, Wi-Fi kopuk vb.), backend işlemi iptal eder, `HOLD` edilen bakiyeyi derhal kullanıcıya iade eder (`RELEASED`) ve peronu `ERROR` moduna alır.

---

## 6. Offline-First & Fail-Safe Mimarisi

- **Donanım Sayacı (Hardware Timer / millis):**
  ESP32 seans süresini kendi iç donanımında sayar. Yıkama sırasında istasyonun interneti kopsa bile, süre dolduğunda ESP32 sunucudan komut beklemeden **otonom olarak röleleri kapatır**. Taşma veya sınırsız su akışı yaşanması imkansızdır.

- **NVS (Non-Volatile Storage) Seans Kurtarma:**
  Seans başladığında seans bilgisi ve bitiş milisaniyesi ESP32 flash belleğine (NVS) yazılır. Yıkama esnasında istasyonun elektriği 1 saniye kesilip geri gelse bile, cihaz yeniden başladığında NVS'den kalan süreyi okur ve seansı kaldığı yerden tamamlar.
