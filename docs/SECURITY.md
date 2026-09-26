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
      └── Refresh Token (opak rastgele değer, 7 gün, HTTP-only Secure SameSite=Strict cookie)
```

| Özellik | Access Token | Refresh Token |
|---|---|---|
| Biçim | JWT HS256 (`JWT_ACCESS_SECRET`), `iss=qwash`, `aud=qwash-api` | 32 bayt rastgele; DB'de yalnız SHA-256 özeti (`RefreshToken`) |
| Ömür | 15 dakika | 7 gün |
| Taşıma | `Authorization: Bearer <token>` header | HTTP-only cookie `qwash_rt`, `Path=/api/v1/auth` |
| Yenileme | `POST /auth/refresh` | Her kullanımda döndürülür |
| İptal | Yok (kısa ömür) | `revokedAt` |

> [!IMPORTANT]
> Access Token kara listeye alınamaz (stateless). Bu nedenle token ömrü kasıtlı olarak kısa (15 dk) tutulmuştur. Çıkış veya şifre değişikliği sonrası access token en fazla 15 dakika geçerli kalabilir; bu kabul edilebilir risk aralığındadır.

> [!NOTE]
> Refresh cookie `SameSite=Strict` olduğu için API ve PWA aynı site altında olmalıdır (ör. `app.qwash...` ve `api.qwash...`). Yerelde ikisi de `localhost` olduğundan sorun yoktur. Tarayıcıdan gelen istekler için `CORS_ORIGINS` listesi kullanılır (credentials açık).

### 1.2 Refresh Token Rotasyonu
`POST /auth/refresh` çağrıldığında (`apps/backend/src/auth/auth.service.ts`):
1. Eski refresh token koşullu güncellemeyle iptal edilir (`revokedAt`); aynı token'la eşzamanlı iki istekten yalnız biri kazanır.
2. Yeni bir refresh token verilir ve cookie güncellenir.
3. Eğer iptal edilmiş token tekrar kullanılırsa → **Token Reuse Saldırısı** tespit edilir → o kullanıcının TÜM aktif oturumları sonlandırılır.
4. Şifre sıfırlandığında da tüm oturumlar kapanır.

### 1.3 Rol Tabanlı Erişim Kontrolü (RBAC)

| Rol | Yetki |
|---|---|
| `USER` | Kendi seansları, kendi cüzdanı, genel peron listesi |
| `ADMIN` | Tüm peronlar, tüm seanslar, nakit yükleme, iade işleme, bakım modu |
| `SUPER_ADMIN` | Admin yetkisi + manuel bakiye düzeltme, yükleme ayarları, tarife, admin rolü verme |

Uygulama ([ADR-0011](adr/0011-admin-operations.md)): `AdminGuard` rolü ve hesap durumunu her istekte veritabanından okur; yetkisi alınan admin bir sonraki isteğinde reddedilir (token'ın 15 dakikası beklenmez). İlk SUPER_ADMIN yalnız komut satırından atanır: `pnpm admin:grant <e-posta> SUPER_ADMIN` (e-postası doğrulanmış hesap). Admin işlemleri değiştirilemez `AdminAuditLog` tablosuna yazılır. MFA henüz yok (canlıdan önce ele alınacak).

---

## 2. Şifre Güvenliği

* **Algoritma:** `scrypt` (Node yerleşik; N=2^15, r=8, p=1, 16 bayt tuz). Parametreler özetin içinde saklanır (`scrypt$N$r$p$tuz$özet`), ileride artırılabilir. Önceki plan `bcrypt` idi; native bağımlılık gerektirmediği ve 72 bayt kesme sorunu olmadığı için scrypt seçildi (2026-09-26).
* **Şifre kuralı:** En az 8, en fazla 72 karakter; karmaşıklık kuralı yok (NIST 800-63B).
* **Kural:** Kullanıcı şifresi asla loglanmaz, asla düz metin olarak DB'ye yazılmaz. Olmayan hesaba giriş denemesinde de scrypt çalıştırılır; yanıt süresi hesabın varlığını sızdırmaz.
* **Brute-force:** Giriş/kayıt/sıfırlama uçları IP başına 15 dakikada 10 istekle sınırlı (`@nestjs/throttler`). Ters vekil arkasında gerçek istemci IP'si için `TRUST_PROXY` canlıda ayarlanmalıdır.
* **E-posta başına sınır:** Şifreyle girişte ayrıca e-posta başına 15 dakikada 10 deneme (`LoginThrottle`, çok IP'li saldırıya karşı). Deneme şifre kontrolünden **önce**, tek atomik UPSERT ile sayılır; eşzamanlı istek yığını sınırı geçemez. Sınır aşılınca doğru şifre de reddedilir (`429 RATE_LIMITED`); hesap olsun olmasın aynı davranış, e-posta tabloda yalnız SHA-256 özetiyle durur. Başarılı giriş, Google girişi ve şifre sıfırlama sayacı siler: saldırgan bir hesabı kilitlerse sahibi sıfırlamayla hemen girer. Süresi dolan kayıtlar saatlik temizlenir (`AuthWorker`).
* **Google girişi:** ID token sunucuda doğrulanır (imza, `aud`, `iss`, `exp`, `email_verified`). Aynı e-postada doğrulanmış yerel hesap varsa ona bağlanır. Doğrulanmamış yerel hesap varsa (şifreyi başkası koymuş olabilir) şifre silinir, açık oturumlar kapatılır ve hesap Google kimliğine bağlanır ([ADR-0009](adr/0009-customer-authentication.md) madde 5).
* **E-posta/sıfırlama token'ları:** 32 bayt rastgele, DB'de yalnız SHA-256 özeti (`AuthToken`), tek kullanımlık. E-posta doğrulama 24 saat, şifre sıfırlama 1 saat geçerli; yeni sıfırlama sonrası kullanılmamış eski bağlantılar iptal olur. Şifremi unuttum ucu hesap olsun olmasın aynı yanıtı verir.
* **E-posta gönderimi:** Sağlayıcı henüz seçilmedi. Geliştirmede bağlantı konsola yazılır; production'da sağlayıcı tanımlanmadan uygulama başlamaz (`auth/mailer.ts`).
* **E-posta doğrulama:** Doğrulanmamış hesap bakiye yükleyemez ve seans başlatamaz.
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

### Sır Değişkenleri

Tam liste ve açıklamalar `.env.example`'da, doğrulama `apps/backend/src/config/env.ts`'te (eksik/yanlış değerde uygulama başlamaz). Sır niteliğinde olanlar:

| Değişken | Not |
|---|---|
| `DATABASE_URL` | Canlıda `?sslmode=require` |
| `MQTT_URL` | Backend'in broker kullanıcısı (`qwash-backend`) şifresi içinde; loglarda gizlenir |
| `JWT_ACCESS_SECRET` | En az 32 karakter rastgele. Refresh token opak olduğu için ayrı refresh anahtarı yok |
| `IYZICO_API_KEY`, `IYZICO_SECRET_KEY` | Webhook V3 imzası da `IYZICO_SECRET_KEY` ile doğrulanır; ayrı webhook anahtarı yok |
| `SMTP_PASSWORD` | Gmail uygulama şifresi |
| `MQTT_*_PASSWORD` | `pnpm mqtt:credentials` ile broker `passwd` dosyasına işlenir (git dışı) |

Redis henüz kullanılmıyor (hız sınırı bellekte, bkz. 8. bölüm).

---

## 7. Güvenlik Denetim Kontrol Listesi

Prod deploy öncesinde aşağıdaki maddeler manuel olarak doğrulanmalıdır:

- [ ] TLS 1.2 altı protokoller devre dışı (Nginx `ssl_protocols TLSv1.2 TLSv1.3`)
- [ ] MQTTS portu `8883` açık, `1883` kapalı
- [x] Tüm Admin endpoint'leri `AdminGuard` ile korumalı (rol veritabanından, Faz 6a)
- [x] `POST /payments/webhook` HMAC (V3) doğrulaması kodda aktif; imzasız bildirim 403. Iyzico V3 imzalı gönderimi açınca uçtan uca denenecek
- [ ] Rate limiting `429` dönüyor (test var); birden fazla backend süreci çalışacaksa depolama Redis'e taşınmalı
- [x] `X-Frame-Options: DENY` ve diğer başlıklar yanıtlarda (helmet, test var)
- [ ] `TRUST_PROXY=1` (Nginx arkasında) ayarlı
- [ ] `NODE_ENV=production` (Swagger kapalı, cookie `Secure`, SMTP zorunlu)
- [ ] `CORS_ORIGINS` canlı alan adlarıyla açıkça ayarlı (varsayılan localhost'tur)
- [ ] DB bağlantısı SSL zorunlu (`?sslmode=require`)
- [x] `.env`, broker `passwd` ve sertifika anahtarları git dışı (2026-09-26 kontrol edildi)

---

## 8. Güvenlik Gözden Geçirmesi (2026-09-26, Faz 7)

Kapsam: kimlik doğrulama, yetkilendirme, sır yönetimi, MQTT, ödeme, hız sınırı. Yöntem: kod okuması + bulguların testle doğrulanması + `pnpm audit --prod`.

### Düzeltilenler

| # | Önem | Bulgu | Düzeltme |
|---|---|---|---|
| 1 | **Kritik** | Hız sınırı atlatılabiliyordu: `UserThrottlerGuard`, `Authorization: Bearer` başlığının özetini **doğrulamadan** kova anahtarı yapıyordu. Giriş ucuna her istekte farklı uydurma bir `Bearer` eklenerek her seferinde yeni kova alınıyor, "15 dk'da 10 deneme" sınırı hiç devreye girmiyordu (şifre kaba kuvvete açık). Mevcut test üretimdeki guard yerine düz `ThrottlerGuard` kullandığı için yakalanmamıştı. | Kullanıcı kovası yalnız imzası doğrulanan token'a verilir, geçersiz token IP'ye sayılır. HTTP testi artık uygulamanın kendi guard'ını kullanır; atlatma testi eski kodda kırmızı, yenide yeşil. |
| 2 | Orta | `trust proxy` yoktu: Nginx arkasında tüm istekler vekilin IP'sinden gelir, IP başına sınır bütün müşterileri birlikte keser (ve saldırgan herkesi kilitleyebilir). | `TRUST_PROXY` ortam değişkeni (canlıda 1). |
| 3 | Orta | Güvenlik başlıkları (4. bölüm) belgede vardı, kodda yoktu. | `helmet`: CSP `default-src 'none'`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, HSTS. |
| 4 | Düşük | Swagger (`/api/docs`) production'da da açıktı; API haritasını dışarı veriyordu. | Yalnız production dışında kurulur. |

### Açık kalanlar (karar/iş bekliyor)

| # | Önem | Bulgu | Öneri |
|---|---|---|---|
| 5 | ~~Orta~~ | ~~Hesap bazlı deneme sınırı yok; çok IP'li saldırıda tek hesaba tahmin sınırsız.~~ **Kapatıldı (2026-09-26):** e-posta başına sınır, bkz. 2. bölüm. | — |
| 6 | Orta | Admin için MFA yok; admin hesabı müşteri PWA'sıyla aynı giriş ve aynı refresh cookie'yi kullanır. | Canlıdan önce admin için TOTP. Yönetici ayrı tarayıcı profili kullanmalı. |
| 7 | Orta | Hız sınırı sayaçları bellekte: yeniden başlatmada sıfırlanır, birden fazla backend sürecinde paylaşılmaz. | Pilot tek süreçle kabul edilebilir; ölçeklenirken Redis depolaması. |
| 8 | Düşük | Müşteri `AccessTokenGuard`'ı hesap durumunu DB'den okumaz: silinen/askıya alınan hesabın token'ı 15 dk okuma uçlarında geçer. Para hareket ettiren uçlar (seans, yükleme, hesap silme) durumu ayrıca kontrol ediyor. | Kabul edilebilir (1.1'deki bilinen risk). |
| 9 | Düşük | Backend–broker bağlantısı düz MQTT (yalnız `127.0.0.1`). Cihazlar TLS + kullanıcı/şifre + ACL kullanıyor; 3.1'deki mTLS/cihaz sertifikası planı henüz uygulanmadı. | Broker ile backend aynı sunucudaysa kabul; ayrı sunucuya çıkarsa backend de TLS. mTLS pilot sonrası. |
| 10 | Düşük | `pnpm audit --prod`: 2 yüksek + 1 orta, hepsi Prisma CLI'nin geçişli bağımlılıkları (`mysql2`, `deepmerge-ts`). PostgreSQL kullanıldığı ve bu yollar çalışma anında yüklenmediği için etkisi yok. | Prisma güncellemesiyle kapanır; takipte. |

### Sağlam bulunanlar

Şifre özeti (scrypt, zamanlama sızıntısı yok), refresh rotasyonu ve tekrar kullanım tespiti, tek kullanımlık e-posta/sıfırlama token'ları, Google ID token doğrulaması ve doğrulanmamış hesap ele geçirme savunması, `AdminGuard`'ın rolü her istekte DB'den okuması, ödeme sonucunun gövdeye güvenmeden Iyzico'dan sorulması (yanıt imzası, tutar, para birimi, `basketId` eşleşmesi, tek CREDIT), webhook imzasının sabit zamanlı karşılaştırılması, callback'te açık yönlendirme olmaması, MQTT'de anonim erişimin kapalı olması ve cihazın ACL ile yalnız kendi peronuna yazabilmesi (backend de mesajın peronunu seansla karşılaştırıyor), Socket.IO odasının token'dan belirlenmesi, loglarda `authorization`/`cookie`/MQTT şifresinin gizlenmesi.
