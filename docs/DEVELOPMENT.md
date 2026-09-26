# QWASH — Development Guide

Bu doküman, yeni bir geliştiricinin projeyi klonlayıp 10 dakika içinde yerel ortamda çalıştırması için gereken adımları içerir.

---

## 1. Ön Gereksinimler
* **Node.js:** v22.12+ (CI v24 LTS kullanır). NestJS 12 ESM dağıtıldığı için CommonJS'ten ESM yükleme (`require(esm)`) desteği gerekir.
* **Paket Yöneticisi:** `pnpm` v12 (sürüm kök `package.json` içindeki `packageManager` alanında sabitlidir)
  ```bash
  corepack enable
  ```
* **Not:** TypeScript bilinçli olarak 6.0'a sabitlidir; `typescript-eslint` ve `ts-jest` henüz 7.x'i desteklemiyor.
* **Docker & Docker Compose:** PostgreSQL, Redis ve Mosquitto konteynerleri için.
* **VS Code / Cursor:** Önerilen eklentiler: ESLint, Prettier, Prisma, Tailwind CSS.

---

## 2. Monorepo Mimarisi & Klasör Düzeni

```text
qwash/
├── apps/
│   ├── backend/          # NestJS API (Port: 3001)
│   ├── web-customer/     # Next.js PWA Müşteri Arayüzü (Port: 3000)
│   └── web-admin/        # Next.js Admin Paneli (Port: 3002)
├── packages/
│   ├── contracts/        # Ortak TypeScript DTO, Enum, Zod & Event tipleri
│   ├── eslint-config/    # Paylaşılan ESLint kuralları
│   └── tsconfig/         # Paylaşılan TypeScript ayarları
├── docker/
│   ├── docker-compose.dev.yml
│   └── mosquitto/
├── docs/                 # Sistem dokümantasyonu & ADR'lar
└── package.json          # Root Monorepo konfigürasyonu
```

---

## 3. Kurulum ve Başlatma (Hızlı Başlangıç)

### 1. Bağımlılıkları Yükle
```bash
pnpm install
```

### 2. Ortam Değişkenlerini Hazırla
```bash
cp .env.example .env
```

### 3. Altyapı Konteynerlerini Başlat (PostgreSQL, Redis, MQTT)
```bash
pnpm infra:up      # konteynerleri başlatır ve healthy olana kadar bekler
pnpm infra:down
```

Host portları bilinçli olarak standart dışıdır, çünkü 5432/6379/1883 çoğu makinede başka projeler veya yerel servisler tarafından kullanılır:

| Servis | Host portu | `.env` değişkeni |
|---|---|---|
| PostgreSQL | `15432` | `POSTGRES_HOST_PORT` |
| Redis | `16379` | `REDIS_HOST_PORT` |
| MQTT | `11883` | `MQTT_HOST_PORT` |
| MQTT WebSocket | `19001` | `MQTT_WS_HOST_PORT` |

### 4. Veritabanı Şemasını ve Seed Verilerini Yükle
```bash
# Migration'ları geliştirme veritabanına uygula
pnpm db:migrate:dev

# Örnek veri: STATION-01 / BAY-001, 4 program, demo@qwash.local (150,00 ₺).
# Tekrar çalıştırılabilir; bakiye iki kez yüklenmez.
pnpm db:seed
```

> Prisma 7 notları: Şema `apps/backend/prisma/schema.prisma`, ayarlar `apps/backend/prisma.config.ts`. İstemci `apps/backend/src/generated/prisma` altına üretilir (git'e girmez); `build`, `typecheck`, `lint` ve `test` komutları önce `prisma generate` çalıştırır. Prisma resmi olarak Node 20.19 / 22.12 / 24 destekler; Node 26'da uyarı verir ama çalışır.

### Entegrasyon Testleri
```bash
pnpm test:integration
```
Gerçek PostgreSQL gerektirir (`pnpm infra:up`). Ayrı bir `qwash_test` veritabanı otomatik oluşturulur ve migration'lar uygulanır; geliştirme veritabanına dokunulmaz. Güvenlik için test veritabanı adının `_test` ile bitmesi zorunludur.

### 5. Tüm Uygulamaları Geliştirme Modunda Çalıştır
```bash
pnpm dev
```

* **Müşteri Web (PWA):** `http://localhost:3000`
* **Backend API & Swagger:** `http://localhost:3001/api/docs`
* **Admin Paneli:** `http://localhost:3002`

---

## 4. Kullanışlı Komutlar

| Komut | Açıklama |
|---|---|
| `pnpm dev` | Monorepo içindeki tüm uygulamaları eşzamanlı çalıştırır (Turborepo) |
| `pnpm build` | Tüm uygulamaları production derlemesine alır |
| `pnpm lint` | Repodaki tüm ESLint kurallarını denetler |
| `pnpm typecheck` | Repodaki tüm TypeScript tip hatalarını denetler |
| `pnpm format` | Prettier ile tüm dosyaları kurallara göre biçimlendirir (`prettier --write .`) |
| `pnpm test` | Unit testleri çalıştırır |
| `pnpm test:e2e` | Uçtan uca Supertest & Playwright testlerini çalıştırır |
| `pnpm db:generate` | Prisma istemcisini oluşturur |
| `pnpm db:migrate:dev` | Geliştirme ortamında Prisma migration uygular (`prisma migrate dev`) |
| `pnpm db:migrate:deploy` | Canlı/Staging ortamında bekleyen migration'ları uygular (`prisma migrate deploy`) |
| `pnpm db:studio` | Prisma Studio veritabanı GUI arayüzünü açar |
| `pnpm db:seed` | Örnek istasyon, peron ve test kullanıcısı verilerini yükler |

---

### Yerel CI ve push öncesi kontrol

GitHub Actions hesap düzeyindeki fatura kilidi çözülene kadar çalışmıyor. Aynı adımlar yerelde çalışır:

- `pnpm ci:local` — `.github/workflows/ci.yml` ile aynı sıra: install, format:check, lint, typecheck, test, test:integration, build, infra:check, gitleaks (Docker). Entegrasyon testi için önce `pnpm infra:up`.
- `pnpm ci:local --quick` — entegrasyon testi, build ve gitleaks hariç (birkaç saniye).
- `.githooks/pre-push` her push'tan önce tam `ci:local` çalıştırır; kırmızıysa push durur. `pnpm install` hook'u `prepare` ile etkinleştirir (`git config core.hooksPath .githooks`). Acil durumda: `git push --no-verify`.

## 5. Test Stratejisi

Proje üç katmanlı test yapısı kullanır. Her katmanın kapsamı ve bağımlılıkları aşağıdaki gibidir:

### Katman 1 — Unit Testler (`pnpm test`)
* **Araç:** Jest + ts-jest
* **Kapsam:** Service sınıfları, durum makinesi geçişleri, finansal hesaplama fonksiyonları.
* **Bağımlılık:** Docker **gerekmez**. Prisma, Redis ve MQTT client'ları `jest.mock()` ile taklit edilir.
* **Örnekler:**
  - `WalletService.hold()` pessimistic lock mantığı
  - `SessionStateMachine` geçersiz durum geçişi reddi
  - Kuruş dönüşüm yardımcı fonksiyonları

### Katman 2 — Integration Testler (`pnpm test:integration`)
* **Araç:** Jest + Supertest + Prisma Test Client
* **Kapsam:** HTTP endpoint'leri uçtan uca (Controller → Service → DB).
* **Bağımlılık:** Docker **gereklidir** (`docker compose -f docker/docker-compose.dev.yml up -d`). Test öncesinde `prisma migrate deploy` çalıştırılır.
* **Örnekler:**
  - `POST /sessions` eşzamanlı çift istek → sadece biri başarılı olmalı
  - `POST /payments/webhook` sahte imzalı istek → `403` dönmeli
  - Idempotency-Key tekrar kullanımı → önbelleklenmiş yanıt dönmeli

### Katman 3 — E2E Testler (`pnpm test:e2e`)
* **Araç:** Playwright
* **Kapsam:** Müşteri PWA ve Admin Panel kullanıcı akışları.
* **Bağımlılık:** Tüm Docker servisleri ve backend **çalışıyor** olmalıdır.
* **Kapsanan Akışlar:**
  - QR okutma → peron rezervasyonu → seans başlatma → geri sayım ekranı
  - Yetersiz bakiye senaryosu → ödeme ekranına yönlendirme
  - Admin: peron bakım moduna alma → perona yeni seans açılamadığının doğrulanması

> [!TIP]
> CI pipeline'da unit ve integration testler her PR'da çalışır. E2E testler yalnızca `main` branch'e merge sonrası staging ortamında tetiklenir (yavaş olduğu için).


## E-posta (SMTP)

Doğrulama ve şifre sıfırlama e-postaları `apps/backend/src/auth/smtp-mailer.ts` ile SMTP üzerinden gider; sağlayıcıdan bağımsızdır (Gmail, Brevo, Resend, SES SMTP...). Ayarlar `.env` dosyasındadır (`.env.example` sonundaki `SMTP_*` ve `MAIL_FROM`). `SMTP_HOST` boşsa geliştirmede bağlantı backend loguna yazılır (`[DEV e-posta]`), production'da uygulama başlamaz.

**Gmail ile geliştirme/küçük pilot (alan adı gerekmez):**
1. Google hesabında 2 adımlı doğrulama açık olmalı.
2. <https://myaccount.google.com/apppasswords> adresinden "QWash" adıyla bir **uygulama şifresi** oluştur (16 hane). Hesap şifreni kullanma.
3. `.env`: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER=<gmail adresin>`, `SMTP_PASSWORD=<uygulama şifresi>`, `MAIL_FROM=QWash <gmail adresin>`. Backend'i yeniden başlat.
4. Dene: PWA'da "Şifremi unuttum" ile kendi adresine bağlantı iste. Backend logunda `E-posta gönderildi (PASSWORD_RESET)` görünmeli (alıcı adresi ve bağlantı loga yazılmaz).

Sınırlar: Gmail günde yaklaşık 500 e-posta ile sınırlıdır ve gönderen adresi senin Gmail'in olur. Canlıda kendi alan adından gönderilmelidir (SPF/DKIM doğrulaması; Gmail ve Yahoo doğrulanmamış toplu postayı reddeder). Alan adı alınınca yalnız `.env` değişir: Brevo/Resend'in SMTP bilgileri ve `MAIL_FROM=QWash <no-reply@alanadin>`.

**Tasarım kararları:**
- Gönderim **arka planda** yapılır, istek beklemez. Beklense SMTP hatası hesap oluşmuşken kaydı 500 yapardı ve "şifremi unuttum" yanıtı hesap varsa yavaş, yoksa hızlı dönerek hesabın var olup olmadığını sızdırırdı. Başarısız gönderim loglanır (`E-posta gönderilemedi`); kullanıcı doğrulamayı hesap sayfasından yeniden isteyebilir.
- Port 587'de STARTTLS **zorunludur**; sunucu TLS sunmazsa düz metne düşülmez, gönderim başarısız olur. Sertifika doğrulaması kapatılmaz.
- Bağlantı ve alıcı adresi loglanmaz.
