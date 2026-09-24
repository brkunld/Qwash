# QWASH — Database Architecture & Data Dictionary

Bu doküman, PostgreSQL veritabanı şemasını, tablo ilişkilerini, değişmez kuralları (invariants) ve indeksleme stratejisini açıklar.

---

## 1. Veritabanı Genel Bakış
* **Motor:** PostgreSQL 16 (LTS)
* **ORM:** Prisma ORM
* **Para Temsili:** Tüm finansal değerler `BigInt` veya `Int` (Kuruş) olarak saklanır.
* **Tarih Standartı:** Tüm zaman alanları `timestamptz` (UTC) tipindedir.

---

## 2. Varlık İlişki Diyagramı (ERD)

```text
┌──────────────┐         1:1         ┌──────────────┐         1:N         ┌──────────────┐
│     User     ├─────────────────────┤    Wallet    ├─────────────────────┤ LedgerEntry  │
│ (Kimlik/Rol) │                     │ (Kuruş Bazlı)│                     │ (Hareketler) │
└──────┬───────┘                     └──────────────┘                     └──────────────┘
       │
       │ 1:N
       ▼
┌──────────────┐         N:1         ┌──────────────┐         N:1         ┌──────────────┐
│ WashSession  ├─────────────────────┤     Bay      ├─────────────────────┤   Station    │
│ (Yıkama Seansı)                    │ (Peron)      │                     │ (İstasyon)   │
└──────┬───────┘                     └──────┬───────┘                     └──────────────┘
       │                                    │ 1:1
       │ 1:N                                ▼
       ▼                             ┌──────────────┐                     ┌──────────────┐
┌──────────────────────┐             │    Device    │                     │ InboxMessage │
│  SessionTransition   │             │ OutboxEvent  │                     │ (Idempotency)│
│ (State Machine Logu) │             │ (MQTT Kuyruk)│                     └──────────────┘
└──────────────────────┘             └──────────────┘
```

---

## 3. Tablo ve Model Tanımları

### `User` & `Wallet`
```prisma
model User {
  id           String       @id @default(uuid())
  email        String       @unique
  passwordHash String?      // Yalnızca Google ile açılan hesapta null (ADR-0009)
  emailVerifiedAt DateTime?
  phoneNumber  String?      @unique // Opsiyonel; MVP'de zorunlu değil
  identities   AuthIdentity[]
  role         UserRole     @default(USER) // USER, ADMIN, SUPER_ADMIN
  status       UserStatus   @default(ACTIVE)
  wallet       Wallet?
  sessions     WashSession[]
  createdAt    DateTime     @default(now())
}

model AuthIdentity {
  id             String   @id @default(uuid())
  userId         String
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  provider       String   // "password" | "google"
  providerUserId String   // Google için sub claim'i
  createdAt      DateTime @default(now())

  @@unique([provider, providerUserId])
}

model Wallet {
  id           String        @id @default(uuid())
  userId       String        @unique
  user         User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  balanceKurus BigInt        @default(0)
  holdKurus    BigInt        @default(0)
  currency     String        @default("TRY")
  ledgerEntries LedgerEntry[]
  updatedAt    DateTime      @updatedAt
}
```

> **Kaynak gerçek:** Faz 2'den itibaren uygulanan şema `apps/backend/prisma/schema.prisma` ve `apps/backend/prisma/migrations/` altındadır. Bu belge tasarımı açıklar; alan düzeyinde fark olursa şema dosyası geçerlidir.

### `LedgerEntry` (Değiştirilemez Muhasebe Kaydı)
```prisma
model LedgerEntry {
  id                String       @id @default(uuid())
  walletId          String
  type              LedgerType   // CREDIT, DEBIT, HOLD, CAPTURE, RELEASE
  source            LedgerSource // CARD_TOPUP, CASH_TOPUP, SESSION, ADJUSTMENT, REFUND
  amountKurus       BigInt       // Her zaman > 0; yön `type` ile belirlenir
  balanceAfterKurus BigInt       // Hareket sonrası bakiye
  holdAfterKurus    BigInt       // Hareket sonrası bloke
  holdId            String?      // HOLD/CAPTURE/RELEASE hareketinin ait olduğu bloke
  referenceId       String?      // SessionId, PaymentId veya CashTopUpId
  idempotencyKey    String?      @unique
  note              String?
  createdAt         DateTime     @default(now())
}
```

### `WalletHold` (Bloke Kaydı)
Her bloke ayrı izlenir. Bir bloke yalnızca bir kez kapatılabilir (`CAPTURED` veya `RELEASED`) ve bloke edilenden fazla tahsil edilemez. Cüzdandaki `holdKurus`, aktif blokelerin toplamıdır.
```prisma
model WalletHold {
  id             String       @id @default(uuid())
  walletId       String
  amountKurus    BigInt       // > 0
  capturedKurus  BigInt       @default(0) // 0 <= captured <= amount
  status         HoldStatus   @default(ACTIVE) // ACTIVE, CAPTURED, RELEASED
  source         LedgerSource
  referenceId    String?
  idempotencyKey String       @unique
  createdAt      DateTime     @default(now())
  settledAt      DateTime?    // status ACTIVE ise null, degilse dolu (CHECK)
}
```

**Hareket anlamları:**
| Hareket | Bakiye | Bloke | Örnek |
|---|---|---|---|
| `CREDIT` | `+tutar` | — | Kart/nakit yükleme |
| `HOLD` | — | `+tutar` (kullanılabilir bakiye yeterliyse) | Seans başlangıcı |
| `CAPTURE` | `-kullanılan` | `-kullanılan` | Seans sonu tahsilat |
| `RELEASE` | — | `-kalan` | Kullanılmayan kısım / ACK gelmedi |
| `DEBIT` | `-tutar` | — | Düzeltme |

Örnek: 3000 kuruş bloke, 1800 kuruş kullanıldı → `CAPTURE 1800` + `RELEASE 1200`.

### `CashTopUp` (Kasada Nakit Yükleme)
Operatör kasada müşteriden nakit alır ve müşterinin bakiyesine yükler. Kart yüklemeden (Iyzico) ve hata düzeltmeden (`ADJUSTMENT`) ayrı bir akıştır; gün sonu kasa mutabakatı bu tablodan yapılır.
```prisma
model CashTopUp {
  id             String   @id @default(uuid())
  walletId       String
  wallet         Wallet   @relation(fields: [walletId], references: [id])
  amountKurus    BigInt   // > 0 (CHECK constraint)
  operatorId     String   // Yuklemeyi yapan admin/operator (User.id)
  stationId      String   // Hangi istasyonun kasasi
  receiptNo      String   @unique // Musteriye verilen makbuz numarasi
  note           String?
  idempotencyKey String   @unique // Cift tiklamada iki kez yuklenmesin
  createdAt      DateTime @default(now())
}
```

### `Station` (İstasyon)
```prisma
model Station {
  id        String      @id @default(uuid())
  code      String      @unique // Örn: "STATION-01", "STATION-IST-03"
  name      String      // Örn: "Kadıköy Merkez İstasyonu"
  address   String?
  cityCode  String?     // Örn: "34" (İstanbul)
  status    StationStatus @default(ACTIVE) // ACTIVE, INACTIVE, MAINTENANCE
  bays      Bay[]
  createdAt DateTime    @default(now())
  deletedAt DateTime?   // Soft-delete: NULL = aktif, dolu = silinmiş
}
```

### `Bay` & `Device`
```prisma
model Bay {
  id          String       @id @default(uuid())
  bayCode     String       @unique // QR kodu (Örn: "BAY-001")
  name        String
  status      BayStatus    @default(IDLE) // IDLE, WAITING, RUNNING, OFFLINE, MAINTENANCE, ERROR
  stationId   String
  station     Station      @relation(fields: [stationId], references: [id])
  device      Device?
  sessions    WashSession[]
  programs    BayProgram[] // Bu peronda gecerli programlar
  createdAt   DateTime     @default(now())
}

// Hangi peronda hangi programin gecerli oldugu ve hangi role kanalina bagli oldugu.
// Program istasyon duzeyinde tanimlanir; perona atama ve role eslemesi burada yapilir.
model BayProgram {
  id         String      @id @default(uuid())
  bayId      String
  bay        Bay         @relation(fields: [bayId], references: [id])
  programId  String
  program    WashProgram @relation(fields: [programId], references: [id])
  relayIndex Int         // Bu perondaki ESP32 role kanali (1..4)
  isEnabled  Boolean     @default(true)

  @@unique([bayId, programId])
  @@unique([bayId, relayIndex]) // Ayni role iki programa atanamaz
}

model Device {
  id                     String       @id @default(uuid())
  deviceId               String       @unique // Benzersiz donanım seri no / kimliği
  bayId                  String       @unique
  bay                    Bay          @relation(fields: [bayId], references: [id])
  macAddress             String       @unique
  firmwareVersion        String
  status                 DeviceStatus @default(OFFLINE) // OFFLINE, ONLINE, BUSY, ERROR, MAINTENANCE
  certificateFingerprint String?      // MQTTS TLS X.509 istemci sertifika parmak izi
  desiredRelayIndex      Int?         // null = tum roleler kapali; 1..4 = aktif role (device twin)
  reportedRelayIndex     Int?
  lastSeenAt             DateTime?
  ipAddress              String?
}
```

### `WashSession` & `SessionTransition`
```prisma
model WashSession {
  id          String         @id @default(uuid())
  userId      String
  user        User           @relation(fields: [userId], references: [id])
  bayId       String
  bay         Bay            @relation(fields: [bayId], references: [id])
  durationSec Int            // Toplam seans suresi
  costKurus   BigInt         // Toplam harcanan kurus tutari
  status      SessionStatus  @default(CREATED)
  startedAt   DateTime?
  endedAt     DateTime?
  programUsages SessionProgramUsage[]
  transitions SessionTransition[]
  createdAt   DateTime       @default(now())
}

model WashProgram {
  id                  String                @id @default(uuid())
  stationId           String?
  station             Station?              @relation(fields: [stationId], references: [id])
  code                String                // "WATER", "FOAM", "WAX", "AIR" veya dinamik program kodu
  name                String                // "Basincli Su", "Aktif Kopuk", "Sicak Cila", "Hava", "Motor Yikama"
  description         String?               // Opsiyonel program aciklamasi
  icon                String?               // UI ikon referansi (orn: "water-drop", "sparkles")
  pricePerSecondKurus Int                   // Orn: 50 (0.50 TL/sn), 100 (1.00 TL/sn), 150 (1.50 TL/sn)
  bayPrograms         BayProgram[]          // Role kanali perona gore BayProgram.relayIndex'te tutulur
  isActive            Boolean               @default(true)
  createdAt           DateTime              @default(now())
  updatedAt           DateTime              @updatedAt
  deletedAt           DateTime?             // Soft-delete: Gecmis seans ve ledger kayitlarinin korunmasi icin
  sessionUsages       SessionProgramUsage[]

  @@unique([stationId, code])
}

model SessionProgramUsage {
  id                 String       @id @default(uuid())
  sessionId          String
  session            WashSession  @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  programId          String
  program            WashProgram  @relation(fields: [programId], references: [id])
  durationSeconds    Int          // Harcanan sure (sn)
  ratePerSecondKurus Int          // O andaki saniyelik birim fiyat (snapshot)
  costKurus          BigInt       // durationSeconds * ratePerSecondKurus
  startedAt          DateTime     @default(now())
  endedAt            DateTime?
}

model SessionTransition {
  id            String       @id @default(uuid())
  sessionId     String
  session       WashSession  @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  fromState     SessionStatus
  toState       SessionStatus
  reason        String?
  correlationId String
  createdAt     DateTime     @default(now())
}
```

### `OutboxEvent` & `InboxMessage` (Reliability Models)
```prisma
model OutboxEvent {
  id            String       @id @default(uuid())
  aggregateType String       // "SESSION", "BAY", "WALLET"
  aggregateId   String
  eventType     String       // "START_WASH", "STOP_WASH"
  payload       Json
  status        OutboxStatus @default(PENDING) // PENDING, PUBLISHED, FAILED
  retries       Int          @default(0)
  createdAt     DateTime     @default(now())
  processedAt   DateTime?

  @@index([status, createdAt])
}

model InboxMessage {
  id          String       @id @default(uuid())
  messageId   String       @unique // Benzersiz MQTT Message / Event UUID (Deduplication anahtarı)
  handler     String       // "MQTT_STARTED_ACK_HANDLER", "MQTT_TELEMETRY_HANDLER"
  payload     Json
  processedAt DateTime     @default(now())
  createdAt   DateTime     @default(now())

  @@index([messageId])
}
```

---

## 4. Veritabanı Kısıtlamaları (Constraints)

Finansal tutarlılığı garanti altına almak için PostgreSQL seviyesinde eklenen kurallar:

```sql
-- 1. Bakiye asla sıfırın altına düşemez
ALTER TABLE "Wallet" ADD CONSTRAINT wallet_positive_balance CHECK ("balanceKurus" >= 0);

-- 2. Bloke tutarı negatif olamaz
ALTER TABLE "Wallet" ADD CONSTRAINT wallet_positive_hold CHECK ("holdKurus" >= 0);

-- 3. Bloke edilen para mevcut bakiyeden büyük olamaz
ALTER TABLE "Wallet" ADD CONSTRAINT wallet_balance_gte_hold CHECK ("balanceKurus" >= "holdKurus");
```

---

## 5. İndeksleme Stratejisi
* `User(email)` ve `User(phoneNumber)`: Hızlı kullanıcı doğrulaması için B-Tree index.
* `Bay(bayCode)`: QR tarandığında anlık peron tespiti için Unique B-Tree index.
* `LedgerEntry(walletId, createdAt)`: Cüzdan ekstresi sorguları için composite index.
* `OutboxEvent(status, createdAt)`: Outbox worker'ın okunmamış olayları milisaniyeler içinde çekmesi için partial index (`WHERE status = 'PENDING'`).
* `Station(code)`: İstasyon kodu ile hızlı arama için Unique index.
* `Bay(stationId)`: Bir istasyondaki tüm peronların sorgulanması için index.

---

## 6. Soft-Delete Politikası (KVKK / Veri Saklı Tutma)

Proje, mevzuat gereklilikleri ve finansal denetim zorunlulukları nedeniyle farklı tablolarda farklı silme politikası uygular:

| Tablo | Politika | Gerekçe |
|---|---|---|
| `User` | **Soft-Delete** (`deletedAt DateTime?`) | KVKK silme talebi. Hesap anonim hale getirilir, finansal kayıtlar korunur. |
| `WashSession` | **Hard-Delete Yasak** | Finansal denetim (audit) zorunluluğu. Hiçbir seans kaydı asla silinemez. |
| `LedgerEntry` | **Immutable / Değiştirilmez** | Muhasebe kaydı. `UPDATE` veya `DELETE` PostgreSQL Row Security ile engellenir. |
| `Station` | **Soft-Delete** (`deletedAt DateTime?`) | Kapatılan istasyon geçmiş seans verilerinin referans bütünlüğünü korur. |
| `Bay` | **Soft-Delete** (`deletedAt DateTime?`) | Kaldırılan peron tarihsel seans kayıtlarını geçersiz kılmamalıdır. |
| `Device` | **Hard-Delete (izin verilir)** | Cihaz yeniden etiketleniyorsa eski kayıt silinebilir; `WashSession` ile doğrudan FK yoktur. |

### KVKK Anonimleştirme Akışı
Kullanıcı silme talebinde:
1. `User.email` → `deleted_<uuid>@anon.qwash` yapılır.
2. `User.phoneNumber` → `NULL` yapılır.
3. `User.passwordHash` → rastgele hash ile üstlerine yazılır.
4. `User.deletedAt` → mevcut zaman damgası yazılır.
5. `WashSession` ve `LedgerEntry` kayıtları **anonim userId ile korunur** (finansal denetim için).
