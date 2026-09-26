# QWASH — API Specification & Standards

Bu doküman, QWASH platformunun RESTful API ve WebSocket (Socket.IO) standartlarını, versiyonlama kurallarını, istek/yanıt şablonlarını ve idempotency mekanizmasını tanımlar.

---

## 1. Genel Kurallar & API Standartları

* **Temel URL:** `https://api.qwash.local/api/v1` (Tüm endpoint'ler `/api/v1` ile başlar).
* **Veri Formatı:** Tüm istek ve yanıt gövdeleri UTF-8 `application/json` formatındadır.
* **Tarih & Saat:** Tüm zaman alanları ISO-8601 UTC formatındadır (`2026-09-17T01:30:00.000Z`).
* **Finansal Tutar:** Tüm para değerleri **Kuruş (Integer)** cinsindendir (`10000` = 100.00 TL).
* **Yetkilendirme:** İstek başlığında Bearer Token zorunludur:  
  `Authorization: Bearer <access_token>`
* **Ortak Sözleşmeler (`@qwash/contracts`):** Tüm HTTP API DTO'ları, istek/yanıt tipleri ve durum enum'ları `@qwash/contracts` paketi altındaki `/src/api/` ve `/src/enums/` modüllerinden tüketilir. Bu sayede Customer Web, Admin Web ve Backend arasında tip güvenliği tek merkezden sağlanır.

---

## 2. Standart Yanıt Formatı (Enveloping)

Tüm başarılı ve başarısız yanıtlar tahmin edilebilir standart bir JSON zarfında (envelope) döner:

### Başarılı Yanıt (Success Envelope)
```json
{
  "success": true,
  "data": { ... },
  "metadata": {
    "correlationId": "req-9876-uuid",
    "timestamp": "2026-09-17T01:30:00.000Z"
  }
}
```

### Hata Yanıtı (Error Envelope)
```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "Seans başlatmak için cüzdan bakiyeniz yetersiz.",
    "details": {
      "requiredKurus": 3000,
      "currentKurus": 1250
    }
  },
  "metadata": {
    "correlationId": "req-9876-uuid",
    "timestamp": "2026-09-17T01:30:00.000Z"
  }
}
```

---

## 3. Idempotency-Key Başlığı (Çift İstek Savunması)

Para düşme, seans başlatma ve ödeme başlatma gibi yan etkili (side-effect) tüm `POST` isteklerinde istemci benzersiz bir `Idempotency-Key` göndermelidir:

```http
POST /api/v1/sessions HTTP/1.1
Host: api.qwash.local
Authorization: Bearer <token>
Idempotency-Key: a3f87b2c-4912-4cf0-9e6b-0b1a2c3d4e5f
Content-Type: application/json
```
Ağ kopması nedeniyle aynı istek tekrar gönderilirse backend işlemi yeniden çalıştırmaz; veritabanındaki önbelleklenmiş ilk cevabı döner.

---

## 4. REST Endpoint Matrisi

### 🔐 Kimlik Doğrulama (`/api/v1/auth`)
* `POST /api/v1/auth/register` — E-posta + şifre ile yeni kullanıcı kaydı (e-posta doğrulama bağlantısı gönderilir). Misafir kullanım yoktur ([ADR-0009](adr/0009-customer-authentication.md)).
* `POST /api/v1/auth/login` — E-posta ve şifre ile giriş (Access Token döner, Refresh Token HTTP-only cookie'ye yazılır).
* `POST /api/v1/auth/google` — Google ID token ile giriş/kayıt. Token sunucuda doğrulanır; `email_verified` olmayan hesap kabul edilmez.
* `POST /api/v1/auth/verify-email` — E-posta doğrulama token'ı ile hesabı doğrulama. Doğrulanmamış hesap bakiye yükleyemez.
* `POST /api/v1/auth/forgot-password` / `POST /api/v1/auth/reset-password` — Tek kullanımlık token ile şifre sıfırlama.
* `POST /api/v1/auth/resend-verification` — (Giriş gerekli) Doğrulama e-postasını tekrar gönderir; 15 dakikada 3 istek.
* `GET /api/v1/me` — Giriş yapmış kullanıcının profili (`emailVerified`, `hasPassword`, `nameLocked` dahil).
* `PATCH /api/v1/me/profile` — Ad güncelleme. İlk başarılı kart yüklemesinden sonra ad mühürlüdür: `409 NAME_LOCKED` (yalnız destek değiştirir). Telefon numarası Iyzico zorunlu alanları netleşince eklenecek.
* `GET /api/v1/me/deletion-preview` — Hesap silme ekranı: kullanılabilir bakiye, FIFO iade dağılımı (`CARD` / `IBAN` / `CASH_AT_STATION`), `ibanRequired`, `hasCashPart`, engeller (`ACTIVE_HOLD`, `TOPUP_IN_PROGRESS`).
* `POST /api/v1/me/delete` — Body `{ balanceChoice?: "FORFEIT" | "REFUND", confirmForfeit?: true, iban?: "TR..", password? }`. Hesabı KVKK m.7'ye göre anonimleştirir (mali kayıtlar kalır). Bakiye varsa seçim zorunlu: `FORFEIT` bakiyeyi `FORFEIT` ledger kaydıyla sıfırlar; `REFUND` tutarı bloke edip `RefundRequest` açar (admin Faz 6'da işler). 365 günü aşan kart kısmı için `IBAN_REQUIRED`. Şifreli hesapta şifre zorunlu. "Bakiyemi kullanmak istiyorum" istemcide silmeyi iptal etmektir.
* `POST /api/v1/auth/refresh` — Cookie'deki refresh token ile yeni access token; refresh token döndürülür.
* `POST /api/v1/auth/logout` — Refresh token'ı iptal eder ve cookie'yi siler.

Sözleşmeler: `packages/contracts/src/auth.ts`. Uygulama: `apps/backend/src/auth/` (Faz 5a, 2026-09-26).

### 🚗 Peron & Program Yönetimi (`/api/v1/bays`)
* `GET /api/v1/bays` — Tüm peronların genel durum listesi (IDLE, RUNNING, MAINTENANCE).
* `GET /api/v1/bays/:bayCode` — **(Uygulandı, 5c; giriş gerekmez, dakikada 30 istek)** QR onay ekranı ("Peron X'e bağlanıyorsunuz"): `{ bayCode, bayName, stationName, available, unavailableReason, programs[], maxDurationSec }`. `unavailableReason`: `MAINTENANCE` / `NO_DEVICE` / `DEVICE_OFFLINE` / `DEVICE_STALE` / `BUSY`; seans başlatma ile aynı kural. Yalnız etkin programlar döner. Bilinmeyen veya biçimsiz kod `404 BAY_NOT_FOUND`.
* `GET /api/v1/bays/:bayCode/programs` — Yalnızca bu perona atanmış ve etkin (`BayProgram.isEnabled`) yıkama programları ve saniyelik kuruş tarifeleri (Örn: Su: 50 kr/sn, Köpük: 100 kr/sn, Cila: 150 kr/sn, Hava: 75 kr/sn).
* `POST /api/v1/bays/:id/prepare` — Peronu 30 saniyeliğine kullanıcıya rezerve etme (`WAITING`).
* `POST /api/v1/bays/:id/cancel-waiting` — Rezervasyonu iptal edip peronu boşa çıkarma.

### ⏱️ Seans & Program Başlatma (`/api/v1/sessions`)
Uygulandı (Faz 5c, 2026-09-26). Tümü giriş ister; yanıt `SessionView` (`packages/contracts/src/sessions.ts`).
* `POST /api/v1/sessions` — `Idempotency-Key` zorunlu. Body `{ "bayCode": "BAY-001", "programCode": "WATER", "durationSec": 120 }`. `durationSec × fiyat` bloke edilir, START outbox'a yazılır, `201` ile `STARTING` seans döner; sonuç (`RUNNING` / `FAILED`) Socket.IO'dan gelir. Aynı anahtar aynı seansı döner (anahtar kullanıcıya bağlıdır). Hatalar: `422 INSUFFICIENT_FUNDS` (`details: { requiredKurus, currentKurus }`), `422 BAY_BUSY`, `422 BAY_UNAVAILABLE`, `422 PROGRAM_NOT_AVAILABLE`, `400 INVALID_DURATION`, `404 BAY_NOT_FOUND`, `403 ACCOUNT_NOT_ACTIVE`, `409 IDEMPOTENCY_CONFLICT`.
* `GET /api/v1/sessions/active` — Aktif (`STARTING` / `RUNNING` / `RECONCILING`) seans veya `null`. PWA açılışta ve `session.resync` sonrası durumu buradan geri yükler.
* `GET /api/v1/sessions/:id` — Seans durumu (bitmiş seansın özeti dahil). Başkasının seansı `404`.
* `POST /api/v1/sessions/:id/stop` — Erken durdurma, `200`. Tahsilat cihaz bitişi bildirince yapılır; üst sınır durdurma anı + 5 sn (ADR-0010 #9).

**Anlık durum (Socket.IO):** `io(API_URL, { auth: { token } })`. Sunucu → istemci: `session.updated` (`SessionView`), `session.resync` (tazele), `auth.error`. Ayrıntı: [ARCHITECTURE.md § 6](ARCHITECTURE.md).

### 💳 Cüzdan & Ödeme (`/api/v1/wallet` & `/api/v1/payments`)
* `GET /api/v1/wallet` — Kullanıcı bakiyesi (`balanceKurus`, `holdKurus` - Tek TL cüzdanı).
* `GET /api/v1/wallet/transactions` — Cüzdan hareket geçmişi (Ledger dökümü: hangi program için ne kadar harcandı).
* `GET /api/v1/payments/topup-options` — (Giriş gerekli) `{ minKurus, maxKurus, presetsKurus }`. Minimumu admin belirler; hazır tutarlar minimumun katlarıdır (min, 2×min, 4×min; max'ı aşanlar çıkarılır).
* `POST /api/v1/payments/topup` — (Giriş + doğrulanmış e-posta + `Idempotency-Key` zorunlu) Body `{ "amountKurus": 10000 }`. İyzico Checkout Form'u açar, `{ topUpId, status: "PENDING", paymentPageUrl }` döner; istemci `paymentPageUrl`'e yönlendirir. Aynı anahtar aynı yüklemeyi döndürür, farklı tutarla `409 IDEMPOTENCY_CONFLICT`. Kullanıcı başına dakikada 5 istek.
* `GET /api/v1/payments/topups/:id` — Yükleme durumu (`PENDING` / `SUCCEEDED` / `FAILED` / `EXPIRED` / `REVERSAL_PENDING` / `REVERSED`); sonuç sayfası bunu okur.

**Sahipsiz bakiye önlemi (Burak, 2026-09-26):** Yükleme başlatma ve hesap silme aynı cüzdan satır kilidini alır; aktif olmayan hesap yükleme başlatamaz (`403 ACCOUNT_NOT_ACTIVE`). Yine de kapanmış hesaba başarılı ödeme gelirse bakiye yazılmaz: kayıt `REVERSAL_PENDING` olur, ödeme İyzico'da önce iptal (aynı gün), olmazsa tam iade ile geri verilir (`REVERSED`); İyzico'ya ulaşılamazsa mutabakat her dakika yeniden dener.
* `POST /api/v1/payments/iyzico/callback` — İyzico ödeme sayfası müşterinin tarayıcısını buraya form POST (`token`) ile döndürür. Gövdeye güvenilmez: sonuç İyzico'dan sorulur (imzalı yanıt), sonra `303` ile `CUSTOMER_APP_URL/wallet/topup-result?id=<topUpId>`'e yönlendirilir.
* `POST /api/v1/payments/webhook` — İyzico bildirimi (bkz. §7). Geçerli imzada sonuç yine İyzico'dan sorulur.

Kart yüklemesi, callback + webhook + dakikalık mutabakat worker'ı üzerinden üç yoldan sonuçlanır; hangisi önce gelirse gelsin tek `CREDIT` oluşur (`CardTopUp` durum geçişi ve ledger aynı transaction'da, anahtar `card-topup:<id>`). Uygulama: `apps/backend/src/payments/` (Faz 5b).

### 🛠️ Admin Uç Noktaları (`/api/v1/admin`)
* `GET /api/v1/admin/dashboard` — Anlık telemetri, aktif seanslar ve ciro metrikleri.
* `POST /api/v1/admin/programs` — Sıfırdan yeni yıkama programı/paketi ekleme (`code`, `name`, `description?`, `icon?`, `pricePerSecondKurus`, `relayIndex`, `stationId?`).
* `GET /api/v1/admin/programs` — İstasyon/peron yıkama programlarını ve saniyelik fiyat tarifelerini listeleme (`includeInactive` filtresi ile).
* `PUT /api/v1/admin/programs/:id` — Program bilgilerini ve saniyelik kuruş fiyatını güncelleme.
* `PUT /api/v1/admin/bays/:id/programs` — Peronda geçerli programları ve her birinin röle kanalını atama (`[{ programId, relayIndex, isEnabled }]`). Aynı röle iki programa atanamaz.
* `PATCH /api/v1/admin/programs/:id/toggle` — Programı anında aktif/pasif duruma alma (`isActive`).
* `DELETE /api/v1/admin/programs/:id` — Programı sistemden silme (Finansal tutarlılık ve geçmiş seansların korunması için Soft-Delete: `deletedAt` atanır, müşteri ekranından derhal kaldırılır).
* `POST /api/v1/admin/bays/:id/maintenance` — Peronu bakım moduna alma/çıkarma.
* `POST /api/v1/admin/users/:id/adjust-balance` — Hata düzeltme amaçlı manuel bakiye değişikliği (Zorunlu audit açıklaması, yalnız `SUPER_ADMIN`). Nakit yükleme için kullanılmaz.
* `POST /api/v1/admin/users/:id/cash-topup` — Kasada nakit alıp müşterinin bakiyesine yükleme. Body: `{ "amountKurus": 10000, "note": "..." }`, `Idempotency-Key` zorunlu. Makbuz numarası üretir; `CashTopUp` + `LedgerEntry(CREDIT, source=CASH_TOPUP)` aynı transaction'da yazılır.
* `GET /api/v1/admin/cash-topups?stationId=&date=` — Gün sonu kasa mutabakatı: istasyon/gün/operatör bazında nakit yükleme listesi ve toplamı.
* `GET /api/v1/admin/audit-logs` — Yönetici işlem denetim geçmişi.

---

## 5. HTTP Durum Kodları Standardı

API tutarlı bir HTTP durum kodu seti kullanır. Her endpoint bu tablodan sapamaz:

| HTTP Kodu | Anlamı | Kullanımı |
|---|---|---|
| `200 OK` | Başarılı GET | Veri listeleme/getirme |
| `201 Created` | Başarılı POST | Seans, ödeme vb. yeni kaynak oluşturuldu |
| `204 No Content` | Başarılı DELETE/PATCH | Yan etkili işlem, dönülecek body yok |
| `400 Bad Request` | Geçersiz istek | Zod/DTO doğrulama hatası |
| `401 Unauthorized` | Kimlik doğrulanmadı | Eksik veya süresi dolmuş JWT |
| `403 Forbidden` | Yetkisiz | JWT geçerli ama kullanıcı rolü yetkilendirmiyor |
| `404 Not Found` | Kaynak bulunamadı | Peron, seans, kullanıcı yok |
| `409 Conflict` | Çakışma | Idempotency-Key daha önce kullanılmış |
| `422 Unprocessable Entity` | İş kuralı ihlali | Yetersiz bakiye, peron mesgul, geçersiz durum geçişi |
| `429 Too Many Requests` | Hız sınırı aşıldı | Rate limit tetiklendi |
| `500 Internal Server Error` | Sunucu hatası | Beklenmedik hata (stack trace loglanır, dışarıya verilmez) |

---

## 6. Rate Limiting Politikası

Sunucu kaynak korum ve kaba kuvvet (brute-force) saldırılarına karşı endpoint grubuna göre farklı limitler uygulanır:

| Grup | Limit | Pencere | Hedef |
|---|---|---|---|
| `POST /auth/login` & `/auth/register` | 10 istek | 15 dakika / IP | Brute-force koruması |
| `POST /payments/topup` | 5 istek | 1 dakika / kullanıcı | Ödeme spam koruması |
| `POST /sessions` | 3 istek | 30 saniye / kullanıcı | Çoklu seans açma engeli |

Girişli isteklerde sayaç kullanıcı (token özeti), girişsizde IP başınadır (`apps/backend/src/http/user-throttler.guard.ts`). İstasyondaki müşteriler mobil operatör NAT'ı arkasında aynı IP'yi paylaşabilir; IP başına sayaç birinin denemesini diğerine yazardı.
| Admin endpoint'leri | 60 istek | 1 dakika / IP | Admin panel koruması |
| Diğer tüm endpoint'ler | 100 istek | 1 dakika / IP | Genel koruma |

Limit aşıldığında `429 Too Many Requests` döner, yanıta `Retry-After: <saniye>` header’ı eklenir.
Uygulama: **Redis** üzerinde `sliding window` algoritması ile.

---

## 7. Webhook Güvenliği (İyzico & Dış Sistemler)

`POST /api/v1/payments/webhook` endpoint’i, İyzico tarafından erişilebilir olmalı ancak sahte isteklere karşı iki katmanlı korunmalıdır:

### 7.1 HMAC İmza Doğrulaması
İyzico Checkout Form bildirimlerine `X-IYZ-SIGNATURE-V3` header’ı ekler ([iyzico webhook](https://docs.iyzico.com/en/advanced/webhook)). İmza: `HMAC-SHA256(secretKey, secretKey + iyziEventType + iyziPaymentId + token + paymentConversationId + status)`, hex. Doğrulama sabit zamanlı karşılaştırmayla yapılır (`apps/backend/src/payments/iyzico.gateway.ts`); imzasız/yanlış imzalı istek `403` alır.

İmza doğru olsa bile bildirimdeki `status` kullanılmaz: backend sonucu İyzico'dan sorar ve yanıtın kendi imzasını (`paymentStatus:paymentId:currency:basketId:conversationId:paidPrice:price:token`) doğrular. Böylece bakiye yalnız İyzico'nun imzalı yanıtıyla yüklenir. İyzico bildirimi 3 kez (15 dk arayla) dener; kaçan bildirimleri mutabakat worker'ı yakalar.

### 7.2 IP Allowlist
Production Nginx / API Gateway katmanında yalnızca [https://developer.iyzico.com/docs/webhooks](https://developer.iyzico.com/docs/webhooks) adresinde yayınlanan İyzico IP aralıklarına izin verilir. Diğer IP'lerden gelen istekler `403` ile reddedilir.

### 7.3 Idempotency
Mükerrer bildirim, callback ve mutabakat aynı `CardTopUp` satırında koşullu durum geçişiyle (`PENDING/EXPIRED → SUCCEEDED`) tekilleştirilir; ledger anahtarı `card-topup:<id>` benzersizdir. Ayrı bir `InboxMessage` kaydı gerekmez.
