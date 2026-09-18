# QWASH — Security Architecture Document

Bu doküman, QWASH platformunun güvenlik mimarisini, token stratejisini, MQTT güvenliğini, webhook korumasını ve sır yönetimini açıklar.

---

## 1. Kimlik Doğrulama & Yetkilendirme (AuthN / AuthZ)

### 1.1 JWT Stratejisi (Access + Refresh Token)

```text
Kullanıcı Girişi
      │
      ▼
POST /auth/login
      │
      ├── Access Token  (JWT, 15 dakika, Authorization Bearer header)
      └── Refresh Token (JWT, 7 gün, HTTP-only Secure SameSite=Strict cookie)
```

| Özellik | Access Token | Refresh Token |
|---|---|---|
| Ömür | 15 dakika | 7 gün |
| Taşıma | `Authorization: Bearer <token>` header | HTTP-only cookie |
| Yenileme | `POST /auth/refresh` | — |
| İptal | Redis kara liste (JTI blacklist) | DB'de hash saklama |

> [!IMPORTANT]
> Access Token kara listeye alınamaz (stateless). Bu nedenle token ömrü kasıtlı olarak kısa (15 dk) tutulmuştur. Kritik işlemlerde (admin bakiye düzeltme) çıkış sonrası token geçerliliği 15 dakika devam edebilir — bu kabul edilebilir risk aralığındadır.

### 1.2 Refresh Token Rotasyonu
`POST /auth/refresh` çağrıldığında:
1. Eski refresh token geçersiz kılınır (DB'den silinir veya `used = true`).
2. Yeni bir refresh token verilir ve cookie güncellenir.
3. Eğer eski token tekrar kullanılırsa → **Token Reuse Saldırısı** tespit edilir → o kullanıcının TÜM aktif oturumları sonlandırılır.

### 1.3 Rol Tabanlı Erişim Kontrolü (RBAC)

| Rol | Yetki |
|---|---|
| `USER` | Kendi seansları, kendi cüzdanı, genel peron listesi |
| `ADMIN` | Tüm peronlar, tüm seanslar, kullanıcı bakiye düzeltme |
| `SUPER_ADMIN` | Admin yetkisi + admin kullanıcı oluşturma, sistem ayarları |

---

## 2. Şifre Güvenliği

* **Algoritma:** `bcrypt` (work factor: `12`)
* **Kural:** Kullanıcı şifresi asla loglanmaz, asla düz metin olarak DB'ye yazılmaz.
* **Admin Sıfırlama:** Admin şifre sıfırlama işlemi tek kullanımlık token (`crypto.randomBytes(32)`) + e-posta akışıyla yapılır. Token 1 saat geçerlidir.

---

## 3. MQTT Güvenliği

### 3.1 Geliştirme vs Üretim Karşılaştırması

| Katman | Geliştirme | Üretim |
|---|---|---|
| Port | `1883` (plaintext) | `8883` (TLS 1.3) |
| Auth | Kullanıcı adı / şifre (ACL dosyası) | mTLS + X.509 Cihaz Sertifikası |
| Topic kısıtı | ACL dosyası ile | Mosquitto Dynamic Security Plugin |
| Sertifika | — | Let's Encrypt (broker) + Özel CA (cihaz) |

### 3.2 Cihaz Sertifika Yaşam Döngüsü

```text
Cihaz Üretim Aşaması
      │
      ├── Özel CA tarafından cihaza özgü X.509 sertifikası imzalanır
      ├── Sertifika + Private Key ESP32 NVS'e yazılır
      └── certificateFingerprint DB'ye kaydedilir
            │
            ▼
Cihaz Sahaya Çıkınca
      ├── MQTTS handshake'te client certificate sunulur
      ├── Broker fingerprint'i doğrular
      └── ACL: yalnızca kendi stationId/bayId topic'lerine erişim
```

> [!CAUTION]
> Private key hiçbir zaman cihazdan dışarı çıkarılamaz. Sertifika süresi dolduğunda (önerilen: 2 yıl) fiziksel bakım sırasında yenilenir ve `Device.certificateFingerprint` güncellenir.

---

## 4. API Güvenlik Başlıkları (HTTP Security Headers)

NestJS'te `helmet` middleware ile aşağıdaki başlıklar tüm yanıtlara eklenir:

```
Content-Security-Policy: default-src 'self'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=()
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

---

## 5. Webhook Güvenliği (İyzico)

Bkz. [API.md § 7. Webhook Güvenliği](./API.md) — HMAC imza doğrulaması ve IP allowlist detayları.

---

## 6. Sır Yönetimi (Secrets Management)

| Kural | Açıklama |
|---|---|
| **Git'e commit yasağı** | `.env` dosyaları `.gitignore`'da. Gerçek değer asla commit edilmez. |
| **`.env.example` şablonu** | Yalnızca yer tutucu değerler (`YOUR_SECRET_HERE`). |
| **Üretim ortamı** | Sırlar Railway / Doppler / AWS Secrets Manager üzerinden ortam değişkeni olarak enjekte edilir. |
| **Rotasyon politikası** | JWT secret: 90 günde bir. DB şifresi: 180 günde bir. İyzico API key: Sızdırılma şüphesinde derhal. |
| **Loglama yasağı** | Hiçbir logger çağrısı şifre, API key veya token içeremez. |

### Zorunlu Sır Değişkenleri

```bash
# .env.example
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/qwash_dev"
REDIS_URL="redis://localhost:6379"
MQTT_BROKER_URL="mqtt://localhost:1883"
JWT_ACCESS_SECRET="YOUR_32_BYTE_RANDOM_SECRET"
JWT_REFRESH_SECRET="YOUR_ANOTHER_32_BYTE_RANDOM_SECRET"
IYZICO_API_KEY="YOUR_IYZICO_API_KEY"
IYZICO_SECRET_KEY="YOUR_IYZICO_SECRET_KEY"
IYZICO_BASE_URL="https://sandbox-api.iyzipay.com"
IYZICO_WEBHOOK_SECRET="YOUR_IYZICO_WEBHOOK_HMAC_SECRET"
```

---

## 7. Güvenlik Denetim Kontrol Listesi

Prod deploy öncesinde aşağıdaki maddeler manuel olarak doğrulanmalıdır:

- [ ] TLS 1.2 altı protokoller devre dışı (Nginx `ssl_protocols TLSv1.2 TLSv1.3`)
- [ ] MQTTS portu `8883` açık, `1883` kapalı
- [ ] Tüm Admin endpoint'leri `ADMIN` rolü guard'ı ile korumalı
- [ ] `POST /payments/webhook` HMAC doğrulaması aktif
- [ ] Rate limiting Redis'te aktif ve `429` doğru dönüyor
- [ ] `X-Frame-Options: DENY` yanıtlarda mevcut
- [ ] DB bağlantısı SSL zorunlu (`?sslmode=require`)
- [ ] `.env` git diff'inde görünmüyor
