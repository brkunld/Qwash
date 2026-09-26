# QWASH — System Architecture Document

Bu doküman, QWASH platformunun sistem mimarisini, veri akışlarını, durum makinelerini ve dağıtık sistem desenlerini açıklar.

---

## 1. Yüksek Seviye Sistem Topolojisi

```
                         ┌───────────────────────┐
                         │   MÜŞTERİ PWA WEB     │
                         │  (Next.js App Router) │
                         └───────────┬───────────┘
                                     │
                          HTTPS / WSS (Socket.IO)
                                     │
                         ┌───────────▼───────────┐       ┌───────────────────────┐
                         │      NESTJS API       │◄─────►│  İYZİCO ÖDEME SİSTEMİ │
                         │   (Modular Monolith)  │       │  (3D Secure Webhook)  │
                         └───────────┬───────────┘       └───────────────────────┘
                                     │
      ┌──────────────────────────────┼──────────────────────────────┐
      │                              │                              │
      ▼                              ▼                              ▼
┌──────────────┐              ┌──────────────┐              ┌──────────────┐
│  POSTGRESQL  │              │    REDIS     │              │  MQTT BROKER │
│  (Prisma DB) │              │ Cache / Lock │              │ (Mosquitto   │
│              │              │ BullMQ Queue │              │   over TLS)  │
└──────┬───────┘              └──────────────┘              └──────┬───────┘
       │                                                           │
       ├── Double-Entry Ledger                                     │ MQTTS
       ├── Transactional Outbox ──(MQTT Worker)───────────────────►│ (TLS 1.3)
       ├── Idempotent Inbox ◄─────(ACK & Telemetry)────────────────┤
       └── Device Twin State                                       ▼
                                                            ┌──────────────┐
                                                            │ ESP32 CİHAZI │
                                                            │ Hardware WDT │
                                                            │ Local Timer  │
                                                            └──────────────┘
```

---

## 2. Finansal Mimari: Double-Entry Ledger & Invariants

Klasik basit bakiye güncellemesi (`balance = balance - 50`) finansal denetimlerde ve eşzamanlı isteklerde patlar. QWASH'ta finansal mimari **Ledger** tabanlıdır:

```text
Customer Wallet
      │
      ├── CREDIT   (+10000 Kuruş) -> İyzico Topup
      ├── HOLD     (-3000 Kuruş)  -> Peron Rezervasyonu (Geçici Bloke)
      ├── CAPTURE  (-3000 Kuruş)  -> Cihaz Başladı (Kalıcı Düşüş)
      └── RELEASE  (+3000 Kuruş)  -> Cihaz Başlamadı/İptal (Bloke İadesi)
```

### 🔒 Veritabanı Seviyesi Değişmezleri (Database Invariants)
Yazılım katmanında bug olsa bile PostgreSQL veri bozulmasını engeller:

```sql
ALTER TABLE "Wallet" ADD CONSTRAINT check_positive_balance CHECK ("balanceKurus" >= 0);
ALTER TABLE "Wallet" ADD CONSTRAINT check_positive_hold CHECK ("holdKurus" >= 0);
ALTER TABLE "Wallet" ADD CONSTRAINT check_valid_hold CHECK ("balanceKurus" >= "holdKurus");
```

### 2.1 Çoklu Program, Dinamik Admin Yönetimi & Saniyelik Fiyatlandırma (Dynamic Multi-Program)
Kullanıcıya her servis için ayrı kredi (su kredisi, köpük kredisi vb.) tanımlanmaz. Kullanıcının tek bir **TL Cüzdan Bakiyesi** (Kuruş cinsinden) bulunur.

* **Admin Tarafından Dinamik Program Yönetimi (Sıfırdan Ekleme/Silme):**
  * Admin, istediği yıkama programını (Basınçlı Su, Köpük, Sıcak Cila, Hava, Motor Yıkama vb.) isim, saniyelik kuruş fiyatı ve **ESP32 Röle Kanalı (`relayIndex`)** belirterek dinamik olarak sisteme ekleyebilir veya silebilir.
  * **Donanımdan Bağımsızlık (Decoupled Firmware):** ESP32 yazılımı program isimlerini bilmez; yalnızca röle kanallarını (1, 2, 3, 4...) açıp kapatır. Bu sayede sahaya gitmeden veya firmware güncellemeden panelden anında yeni hizmet paketi tanımlanabilir.
  * **Finansal Güvenlik (Soft-Delete):** Kullanılmış bir program fiziksel olarak silinmez; `deletedAt` atanarak arşivlenir. Böylece geçmiş seans dökümleri ve muhasebe kayıtları asla bozulmaz.

* **Hesaplama Formülü:**
  $$\text{Tutar (Kuruş)} = \text{Süre (Saniye)} \times \text{Program Saniyelik Fiyatı (Kuruş)}$$

* **Örnek Tüketim Akışı:**
  1. Kullanıcı cüzdanına 150 TL (15.000 Kuruş) yükler. (`balance = 150.00 TL`)
  2. Su programını seçip 120 saniye çalıştırır: $120 \times 0.50 = 60.00\text{ TL}$ düşülür. (`balance = 90.00 TL`)
  3. Ardından Köpük programını seçip 30 saniye çalıştırır: $30 \times 1.00 = 30.00\text{ TL}$ düşülür. (`balance = 60.00 TL`)
  4. Her adımda ilgili röle açılır/kapanır ve ledger kaydı oluşturulur.

---


## 3. Seans Durum Makinesi (Session State Machine)

Seans yönetimi keyfi `if/else` bloklarıyla değil, deterministik bir durum makinesi ile yönetilir:

```
[ CREATED ]
     │
     ▼ (QR Okutuldu)
[ RESERVED ] ──(Zaman Aşımı: 30 sn)──► [ CANCELLED ]
     │
     ▼ (Kullanıcı Başlat Dedi)
[ FUNDS_HELD ] ──(Bakiye Yetersiz)──► [ FAILED ]
     │
     ▼ (Outbox Event Yazıldı)
[ START_COMMAND_SENT ]
     │
     ├── (ESP32 STARTED_ACK Geldi) ──► [ RUNNING ]
     │                                     │
     │                                     ▼ (Süre Doldu veya Durduruldu)
     │                                 [ STOP_COMMAND_SENT ]
     │                                     │
     │                                     ▼ (ESP32 STOPPED_ACK)
     │                                 [ COMPLETED ]
     │
     └── (10 sn Timeout / NACK)
             │
             ▼
        [ START_TIMEOUT ] ──► [ FUNDS_RELEASED ] ──► [ FAILED ]
```

Her durum geçişinde:
`previousState`, `newState`, `eventId`, `actorId`, `correlationId` ve `timestamp` loglanır.

> [!NOTE]
> **Command Acknowledgement (ACK) vs Dağıtık 2PC:**
> Sistemde kullanılan "Two-Phase ACK" mekanizması, dağıtık veritabanlarındaki bloklayıcı "Two-Phase Commit (2PC)" protokolü değildir. Bu, asenkron ve güvenilir bir IoT komut-onay mutabakatıdır (Bakiye Bloke -> MQTT START -> ESP32 Donanım ACK -> Bakiye Tahsilat).

---

## 4. Güvenilirlik Mimarisi: Transactional Outbox & Inbox

### 💥 Problem (Dual-Write Tuzağı)
Sunucu veritabanına "Seans başladı" yazar ama o milisaniyede elektrik kesilirse MQTT mesajı cihaza gidemez. Sonuç: Kullanıcıdan para kesilir ama su akmaz! Tersine önce MQTT atılıp sonra DB yazılamazsa kaçak yıkama oluşur.

### 🛡️ Çözüm (Transactional Outbox Pattern)
```text
Database Transaction (PostgreSQL)
        │
        ├── 1. WashSession durumunu güncelle (START_COMMAND_SENT)
        ├── 2. Bakiye bloke kaydını yaz (HOLD)
        └── 3. OutboxEvent tablosuna olayı INSERT et (PENDING)
              │
              ▼
        [ TRANSACTION COMMIT ] (Atomik: Ya hep ya hiç!)
              │
              ▼
        Outbox Worker (Arka Plan Asenkron Publisher)
              ├── OutboxEvent tablosundan PENDING olayları oku (FOR UPDATE SKIP LOCKED)
              ├── MQTT Broker'a QoS 1 ile idempotent publish et
              └── Başarılıysa OutboxEvent durumunu PUBLISHED olarak güncelle
```

### 📥 Idempotent Inbox (Mükerrer Mesaj Savunması)
Ağ kopmaları veya MQTT QoS 1 yeniden iletimleri nedeniyle aynı paket birden fazla kez teslim edilebilir:
- Sahadan gelen her MQTT mesajı benzersiz bir `messageId` (UUID) taşır.
- Backend mesajı aldığında, aynı veritabanı transaction'ında `InboxMessage` tablosuna `messageId` ile kaydeder (`UNIQUE` index).
- Eğer `messageId` daha önce kaydedilmişse veritabanı seviyesinde `UNIQUE violation` yakalanır ve mesaj hiçbir yan etki üretmeden güvenle atlanır (Idempotent Consumer).

---

## 5. IoT Entegrasyonu: Device Twin & Device Identity

### 🔑 Cihaz Kimliği & Kapsamlı Yetkilendirme (Device Identity & Scope)
Her peron donanımı (ESP32) kurumsal IoT güvenlik ilkelerine uygun olarak yönetilir:
- **Donanımsal Kimlik (MAC Adresi - `macAddress`):** ESP32'nin fabrika çıkışlı benzersiz donanım MAC adresi (`WiFi.macAddress()`, örn: `246F28ABCDEF`) cihazın tekil kodu (`deviceId`) olarak kullanılır. Kodun içine elle ID yazılmaz (Zero-Config).
- **Wi-Fi Kurulumu (Captive Portal):** Cihaz sahada ilk açıldığında veya ağ koptuğunda `QWASH-AP-<MAC>` adında bir erişim noktası (AP) açarak web arayüzü üzerinden istasyon Wi-Fi bilgilerinin girilmesini sağlar.
- **İstasyon & Peron Kapsamı (`stationId` / `bayId`):** Her cihaz yalnızca tek bir istasyona ve perona atanabilir (1:1 ilişki).
- **Yetkilendirme Sınırı (Topic Scoping):** Cihaz kimlik doğrulaması (MQTTS TLS Client Certificate veya X.509 Fingerprint) ile yalnızca `qwash/station/:stationId/device/:macAddress/#` altındaki topic'lere erişebilir; diğer peronların komutlarını dinleyemez veya taklit edemez.

### 🔄 Device Twin & Drift Tespiti
Backend, peron donanımının anlık durumunu iki kopya halinde tutar:

1. **Desired State (Hedeflenen Durum):** Sistemin cihazdan beklediği durum (Örn: `relay: ON, session: RUNNING`).
2. **Reported State (Cihazın Raporladığı Durum):** Cihazın telemetriyle bildirdiği gerçek donanım durumu (Örn: `relay: OFF, current_draw: 0A`).

```text
Desired State != Reported State (Tolerans süresi aşıldığında)
                     │
                     ▼
             [ DEVICE_DRIFT ]
                     │
                     ▼
         Admin Paneline Anlık Uyarı
    (Örn: "1 Nolu Peron Rölesi Çekmedi veya Donanım Kilitlendi")
```

---

## 6. Realtime Gateway Topolojisi

Müşteri ve Admin arayüzlerinin sunucuyu sürekli yoklamasını (polling) engellemek için **Socket.IO Gateway** kullanılır:

**Uygulanan (Faz 5c, 2026-09-26):** `apps/backend/src/realtime/`, sözleşme `packages/contracts/src/sessions.ts`.

| Room | Katılan Kim | Ne Zaman | Event'ler |
|---|---|---|---|
| `user:{userId}` | Doğrulanmış müşteri soketi | Bağlanınca otomatik; istemci oda seçemez | `session.updated` (`SessionView`), `session.resync` |

- **Kaynak:** Her seans durum geçişi (`SessionTransition` yazımı) aynı transaction içinde `pg_notify('qwash_session_changed', sessionId)` çağırır. PostgreSQL bildirimi yalnız commit'te iletir: geri alınan değişiklik müşteriye hiç görünmez. Değişiklik API'den, MQTT işleyicisinden, taramadan veya başka bir backend kopyasından gelse de tüm dinleyicilere ulaşır (çoklu instance için Redis adapter gerekmez; soket hangi kopyadaysa o kopya yayınlar).
- **Sıra:** Aynı seansın bildirimleri sırayla işlenir; eski okuma yeni durumun üstüne yazamaz.
- **Geri sayım:** Sunucu saniyelik tick göndermez. İstemci `startedAt + plannedDurationSec` ile hesaplar, saat farkını `serverTime` ile düzeltir. Cihaz ekranı zaten yerel sayaçla sayar (IOT.md).
- **Kopma:** LISTEN bağlantısı koparsa 2 sn'de yeniden kurulur ve tüm istemcilere `session.resync` gider; aradaki bildirimler kaybolmuş olabilir, istemci `GET /sessions/active` ile tazelenir. PWA arka plandan dönünce de aynı yolu izler (ADR-0008).

Sonraya bırakılanlar: `BAY_STATUS_CHANGED` genel peron odası ve admin telemetri odası (Faz 6). QR sonrası 30 sn rezervasyon (`BAY_PREPARED`) uygulanmadı; peron seans başlatılınca `WAITING` olur, tek aktif seans kısıtı çakışmayı engeller.

### Bağlantı Yaşam Döngüsü

```text
io(url, { auth: { token: <access token> } })
    │
    ├── [Başarılı] → handleConnection token'ı doğrular
    │         → socket.data.userId atanır, user:{userId} odasına girer
    │
    ├── [Başarısız] → auth.error { code: 'UNAUTHENTICATED' } + disconnect
    │
    └── [Disconnect]
              → Seans cihazda ve sunucuda devam eder
              → İstemci yeniden bağlanınca GET /sessions/active ile durumu geri yükler
```

> [!NOTE]
> Token yalnız bağlantı anında doğrulanır; süresi dolsa da açık bağlantı sürer. İstemci token'ı yenileyince yeni token'la yeniden bağlanır.
