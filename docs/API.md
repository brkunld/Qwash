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
* `PATCH /api/v1/me/profile` — Ad ve opsiyonel telefon numarası güncelleme (telefon yalnızca gerekirse istenir).
* `POST /api/v1/auth/refresh` — Refresh token ile yeni access token alma.
* `POST /api/v1/auth/logout` — Oturumu sonlandırma ve token'ı kara listeye alma.

### 🚗 Peron & Program Yönetimi (`/api/v1/bays`)
* `GET /api/v1/bays` — Tüm peronların genel durum listesi (IDLE, RUNNING, MAINTENANCE).
* `GET /api/v1/bays/:bayCode` — QR okutulduğunda peron detayını ve seans hazırlığını getirme.
* `GET /api/v1/bays/:bayCode/programs` — Perondaki aktif yıkama programları ve saniyelik kuruş tarifeleri (Örn: Su: 50 kr/sn, Köpük: 100 kr/sn, Cila: 150 kr/sn, Hava: 75 kr/sn).
* `POST /api/v1/bays/:id/prepare` — Peronu 30 saniyeliğine kullanıcıya rezerve etme (`WAITING`).
* `POST /api/v1/bays/:id/cancel-waiting` — Rezervasyonu iptal edip peronu boşa çıkarma.

### ⏱️ Seans & Program Başlatma (`/api/v1/sessions`)
* `POST /api/v1/sessions` — Belirli bir program için yıkama başlatma isteği:
  * Body: `{ "bayId": "uuid", "programCode": "WATER", "durationSeconds": 120 }`
  * Tutar: `durationSeconds * ratePerSecondKurus` hesaplanır (120 sn * 50 kr = 60.00 TL).
  * Tek TL bakiyesinden tutar kadar HOLD edilir, ilgili röle için Two-Phase ACK başlar.
* `GET /api/v1/sessions/active` — Kullanıcının aktif devam eden seansı, aktif programı ve kalan süresi.
* `POST /api/v1/sessions/:id/stop` — Aktif programı erken durdurma isteği (Kullanılmayan saniyeler hesaplanıp TL bakiyesine anında iade/release edilir).

### 💳 Cüzdan & Ödeme (`/api/v1/wallet` & `/api/v1/payments`)
* `GET /api/v1/wallet` — Kullanıcı bakiyesi (`balanceKurus`, `holdKurus` - Tek TL cüzdanı).
* `GET /api/v1/wallet/transactions` — Cüzdan hareket geçmişi (Ledger dökümü: hangi program için ne kadar harcandı).
* `POST /api/v1/payments/topup` — İyzico 3D Secure ile cüzdana TL yükleme başlatma.
* `POST /api/v1/payments/webhook` — İyzico 3D Secure dönüş webhook'u.

### 🛠️ Admin Uç Noktaları (`/api/v1/admin`)
* `GET /api/v1/admin/dashboard` — Anlık telemetri, aktif seanslar ve ciro metrikleri.
* `POST /api/v1/admin/programs` — Sıfırdan yeni yıkama programı/paketi ekleme (`code`, `name`, `description?`, `icon?`, `pricePerSecondKurus`, `relayIndex`, `stationId?`).
* `GET /api/v1/admin/programs` — İstasyon/peron yıkama programlarını ve saniyelik fiyat tarifelerini listeleme (`includeInactive` filtresi ile).
* `PUT /api/v1/admin/programs/:id` — Program bilgilerini, saniyelik kuruş fiyatını veya röle numarasını güncelleme.
* `PATCH /api/v1/admin/programs/:id/toggle` — Programı anında aktif/pasif duruma alma (`isActive`).
* `DELETE /api/v1/admin/programs/:id` — Programı sistemden silme (Finansal tutarlılık ve geçmiş seansların korunması için Soft-Delete: `deletedAt` atanır, müşteri ekranından derhal kaldırılır).
* `POST /api/v1/admin/bays/:id/maintenance` — Peronu bakım moduna alma/çıkarma.
* `POST /api/v1/admin/users/:id/adjust-balance` — Manuel bakiye tanımlama (Zorunlu audit açıklaması).
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
| Admin endpoint'leri | 60 istek | 1 dakika / IP | Admin panel koruması |
| Diğer tüm endpoint'ler | 100 istek | 1 dakika / IP | Genel koruma |

Limit aşıldığında `429 Too Many Requests` döner, yanıta `Retry-After: <saniye>` header’ı eklenir.
Uygulama: **Redis** üzerinde `sliding window` algoritması ile.

---

## 7. Webhook Güvenliği (İyzico & Dış Sistemler)

`POST /api/v1/payments/webhook` endpoint’i, İyzico tarafından erişilebilir olmalı ancak sahte isteklere karşı iki katmanlı korunmalıdır:

### 7.1 HMAC İmza Doğrulaması
İyzico her webhook isteğine `X-IYZ-SIGNATURE` header’ı ekler. Backend bu imzayı doğrulamadan hiçbir işlem yapmaz:

```typescript
// packages/contracts/src/utils/webhook.ts
import * as crypto from 'crypto';

export function verifyIyzicoSignature(
  rawBody: Buffer,
  signature: string,
  secretKey: string,
): boolean {
  const computed = crypto
    .createHmac('sha256', secretKey)
    .update(rawBody)
    .digest('base64');
  // Timing-safe compare — string karşılaştırmasının timing attack’a açık olmaması için
  return crypto.timingSafeEqual(
    Buffer.from(computed),
    Buffer.from(signature),
  );
}
```

### 7.2 IP Allowlist
Production Nginx / API Gateway katmanında yalnızca [https://developer.iyzico.com/docs/webhooks](https://developer.iyzico.com/docs/webhooks) adresinde yayınlanan İyzico IP aralıklarına izin verilir. Diğer IP'lerden gelen istekler `403` ile reddedilir.

### 7.3 Idempotency
Webhook isteklerinde de `paymentId` benzersiz kimlik üzerinden `InboxMessage` tablosuna kaydedilerek mükerrer işleme (double-processing) engellenir.
