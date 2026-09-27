# QWASH — Deployment & CI/CD Guide

Bu doküman, QWASH platformunun ortam yönetimini, CI/CD pipeline yapısını ve production deploy adımlarını açıklar.

---

## 1. Ortam Matrisi (Environment Matrix)

| Özellik | Development | Staging | Production |
|---|---|---|---|
| Amaç | Geliştirici yerel ortamı | Test & QA ortamı | Son kullanıcı ortamı |
| Deploy Tetikleyici | Manuel (`pnpm dev`) | `main` branch'e push | Manuel onay + tag (`v*`) |
| DB | Docker PostgreSQL | Managed PostgreSQL | Managed PostgreSQL |
| Redis | Docker Redis | Managed Redis | Managed Redis |
| MQTT | Mosquitto (plaintext 1883) | Mosquitto (TLS 8883) | Mosquitto (TLS 8883) |
| İyzico | Sandbox | Sandbox | Production |
| Domain | `localhost` | `staging.qwash.com.tr` | `qwash.com.tr` |
| SSL | Hayır | Let's Encrypt | Let's Encrypt |
| Seed data | Evet (`pnpm db:seed`) | Evet (test verisi) | Hayır |

---

## 2. CI/CD Pipeline (GitHub Actions)

### 2.1 PR Kontrol Akışı (Her Pull Request)

```text
PR Açıldı / Güncellendi
      │
      ├── 1. Lint         → pnpm lint        (ESLint tüm repo)
      ├── 2. Typecheck    → pnpm typecheck    (TypeScript strict)
      ├── 3. Unit Tests   → pnpm test        (Jest, Docker yok)
      ├── 4. Build        → pnpm build       (Turborepo)
      └── 5. Contract Test → Zod şema doğrulaması (@qwash/contracts)
            │
            ├── [Başarılı] → PR merge'e açık
            └── [Başarısız] → PR bloke, merge yasak
```

### 2.2 Staging Deploy Akışı (`main` branch push)

```text
main branch'e merge
      │
      ├── 1. Tüm PR kontrolleri tekrar çalışır
      ├── 2. Docker imajları build edilir ve registry'e push edilir
      ├── 3. Staging ortamına deploy edilir
      ├── 4. prisma migrate deploy (bekleyen migration'lar uygulanır)
      ├── 5. Smoke Test (health check endpoint'leri doğrulanır)
      └── 6. E2E Test → Playwright (staging üzerinde)
            │
            ├── [Başarılı] → Staging yeşil ✅
            └── [Başarısız] → Otomatik rollback + Slack bildirimi
```

### 2.3 Production Deploy Akışı (Tag Push `v*`)

```text
git tag v1.2.0 && git push --tags
      │
      ├── 1. Staging'den onaylanmış Docker imajı promote edilir
      ├── 2. Manuel onay adımı (GitHub Environment Protection)
      ├── 3. Production'a deploy (Blue-Green veya Rolling)
      ├── 4. prisma migrate deploy
      ├── 5. Health check (60 saniye bekleme)
      └── 6. Smoke Test
            │
            ├── [Başarılı] → Deploy tamamlandı ✅
            └── [Başarısız] → Otomatik rollback + PagerDuty alert
```

---

## 3. Health Check Endpoint'leri

| Endpoint | Kontrol Edilen | Başarı Kriteri |
|---|---|---|
| `GET /health` | Temel sunucu canlılığı | `200 OK` |
| `GET /health/db` | PostgreSQL bağlantısı | `200 OK` + `{ db: "ok" }`; düşükse `503` |
| `GET /health/mqtt` | MQTT broker bağlantısı | `200 OK` + `{ mqtt: "ok" }`; düşükse `503` |
| `GET /health/ready` | Veritabanı + MQTT birlikte (yük dengeleyicinin "trafik verilebilir mi" sorusu) | `200 OK`; değilse `503` ve `error.details` içinde hangisinin düştüğü |

> [!NOTE]
> `/health/redis` yoktur: Redis şu an hiçbir şey için kullanılmıyor (hız sınırı backend belleğinde, `SECURITY.md` §8). Redis kullanılmaya başlanınca uç eklenir.

**Alarmlar (Faz 7 izleme):** backend her 30 sn'de kuralları tarar (`monitoring/alarm.service.ts`): peron cihazı 3+ dk çevrimdışı, 10+ dk `RECONCILING`'de seans, son 30 dk'da 3+ ACK zaman aşımı, 15+ dk takılan kart iptali/iade parçası, 60+ sn cihaza gitmeyen komut, 60+ sn MQTT kopukluğu, 1+ saat bekleyen inceleme. Her alarm loga (`ALARM:`) ve `GET /api/v1/admin/alarms`'a yazılır; `ALERT_EMAIL` ve `SMTP_*` tanımlıysa e-posta da gider: açılışta, 6 saatte bir hatırlatma ve kapanışta (her taramada değil). `pnpm smoke` açık alarmları bildirir. Kanal şimdilik e-postadır; Telegram/SMS gerekirse `AlertNotifier` arayüzüne eklenir.
> Log toplama (merkezi depolama, arama) production altyapısıyla (alan adı ve sunucu belli olunca) kurulacak; log şu an stdout'a JSON yazılır.

> [!NOTE]
> `/health` endpoint'i yetkilendirme (JWT) gerektirmez ve yük dengeleyici (load balancer) tarafından düzenli aralıklarla çağrılır.

---

## 4. Ortam Değişkenleri Referansı

```bash
# ─── Veritabanı ───
DATABASE_URL="postgresql://qwash:PASSWORD@db:5432/qwash"

# ─── Redis ───
REDIS_URL="redis://redis:6379"

# ─── MQTT ───
MQTT_BROKER_URL="mqtts://mqtt.qwash.com.tr:8883"  # prod
# MQTT_BROKER_URL="mqtt://localhost:1883"           # dev

# ─── JWT ───
JWT_ACCESS_SECRET="<32+ byte random>"
JWT_ACCESS_EXPIRES_IN="15m"
JWT_REFRESH_SECRET="<32+ byte random — farklı olmalı>"
JWT_REFRESH_EXPIRES_IN="7d"

# ─── İyzico ───
IYZICO_API_KEY="<iyzico api key>"
IYZICO_SECRET_KEY="<iyzico secret key>"
IYZICO_BASE_URL="https://api.iyzipay.com"           # prod
# IYZICO_BASE_URL="https://sandbox-api.iyzipay.com" # dev/staging
IYZICO_WEBHOOK_SECRET="<webhook hmac secret>"

# ─── Uygulama ───
NODE_ENV="production"
PORT="3001"
FRONTEND_URL="https://qwash.com.tr"
```

---

## 5. Rollback Prosedürü

Prod deploy sonrası kritik hata tespit edildiğinde:

```bash
# 1. Önceki Docker imaj tag'ini bul
docker images qwash/backend --format "{{.Tag}}"

# 2. Önceki versiyona rollback
docker service update --image qwash/backend:v1.1.9 qwash_backend
```

> [!CAUTION]
> Prisma migration'ları geri alınamaz işlemler içerebilir (column drop vb.). Her migration'da `down` script'i ayrıca hazırlanmalı ve `docs/ADR/` altında belgelenmelidir.

---

## 6. Yedekleme ve Geri Yükleme (Faz 7)

Yedeklenen tek şey PostgreSQL'dir: cüzdanlar, ledger, seanslar, ödemeler ve denetim kaydı orada. Redis (hız sınırı, kuyruk) ve Mosquitto durumu yeniden üretilebilir; kayıp para kaydı doğurmaz.

| Komut | Ne yapar |
|---|---|
| `pnpm db:backup` | Docker'daki Postgres'ten `pg_dump -Fc` alır: `backups/qwash-<zaman>.dump` (git dışı). Son `BACKUP_KEEP` (14) yedek tutulur. |
| `pnpm db:restore-verify [dosya]` | Yedeği (verilmezse en yenisini) **geçici bir veritabanına** geri yükler, doğrular, geçici veritabanını siler. Gerçek veritabanına dokunmaz. |

**Doğrulama neyi kanıtlar:** `pg_restore` hatasız biter; tablo satır sayıları raporlanır; her cüzdanda `bakiye = Σ CREDIT − Σ DEBIT − Σ CAPTURE` ve `bloke = Σ HOLD − Σ RELEASE − Σ CAPTURE` geri yüklenen kopyada tutar. Tutmazsa komut hata koduyla biter. Doğrulayıcının bozuk veriyi yakaladığı elle denendi (bir bakiye +1 ₺ bozulunca 1 uyuşmazlık bildirdi).

**Gerçek felakette geri yükleme (elle, sırayla):**
1. Backend'i durdur (yeni seans/ödeme yazılmasın).
2. Bozuk veritabanını sakla (silme, adını değiştir): `ALTER DATABASE qwash RENAME TO qwash_bozuk_<tarih>`.
3. Boş veritabanı aç: `CREATE DATABASE qwash`.
4. `docker exec -i <postgres> pg_restore -U <kullanıcı> -d qwash --no-owner < backups/<dosya>.dump`
5. Backend'i aç, `/api/v1/health` ve admin panelinde kasa raporunu kontrol et.
6. Yedek ile felaket arasındaki işlemler (Iyzico yüklemeleri, nakit yüklemeler) kayıptır: Iyzico panelinden ve kasa makbuzlarından o aralığı elle karşılaştır.

**Sınırlar (bilerek):**
- Yedek anlıktır (RPO = son yedekten beri geçen süre). Saatlik/anlık kurtarma (WAL arşivi, PITR) production'da yönetilen PostgreSQL ile gelir; alan adı ve sunucu belli olunca karar verilir.
- Yedekler aynı makinede durur. Production'da makine dışına (şifreli) kopyalanmalı; ayrıca planlı çalıştırma (cron/Görev Zamanlayıcı) production kurulumunda eklenir.
- Yedek dosyası kişisel veri ve para kayıtları içerir: paylaşma, repoya koyma.
