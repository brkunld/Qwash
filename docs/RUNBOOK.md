# QWASH — Operasyon Runbook'u (Faz 7)

Yaygın arızalarda **ne görülür, para güvende mi, ne yapılır**. Sayılar (10 sn, 90 sn, 30 dk…) `apps/backend/src/session/session.service.ts` içindeki `DEFAULT_TIMINGS` ve `docs/IOT.md`'den alınmıştır; değişirse burası da güncellenmelidir.

## 0. Önce ne yapılır

1. **`pnpm smoke`** çalıştır (`scripts/smoke.mjs`). Salt okur; para, seans veya kayıt değiştirmez. Hesap bilgisi verilmezse müşteri/admin/cihaz bölümleri **atlanır ve doğrulanmış sayılmaz**.
2. Çıktıdaki ilk `HATA` satırına karşılık gelen bölüme git.
3. Admin panelinde **Peronlar** ekranına bak: peron durumu, cihaz "son görülme", sapma (drift).
4. Şüphede önce durdur, sonra araştır: peron **bakım moduna** al (süren seans kesilmez, yenisi başlamaz) ya da seansı **acil durdur** (`ADMIN_OVERRIDE`).

`pnpm smoke` ortamı: `SMOKE_BASE_URL`, `SMOKE_CUSTOMER_EMAIL/PASSWORD`, `SMOKE_ADMIN_EMAIL/PASSWORD` (ayrıntı betiğin başında). Saha için ayrı, düşük yetkili hesaplar kullan; şifreleri depoya yazma. Giriş ucu **IP başına 15 dakikada 10 deneme** verir, bir smoke koşusu 2 giriş harcar; art arda çok koşarsan `429` alırsın (betik bunu "kontrol YAPILAMADI" diye bildirir). Sayaç backend belleğindedir: süre dolunca ya da backend yeniden başlayınca sıfırlanır.

**Alarmlar:** backend arıza koşullarını kendisi izler ve `ALERT_EMAIL` tanımlıysa e-posta atar (`docs/DEPLOYMENT.md` §3). Açık alarmlar: `GET /api/v1/admin/alarms` veya `pnpm smoke`. Her alarmın metni bu belgedeki ilgili bölümü gösterir; alarm kendiliğinden kapanır (kapanışta "COZULDU" e-postası gelir). Alarm anahtarları: `device-offline:<PERON>` (§3), `sessions-reconciling` (§5), `ack-timeouts` (§4), `payments-stuck` (§8–9), `outbox-backlog` ve `mqtt-down` (§10), `sessions-need-review` (§6).

## 1. Arıza tablosu (hızlı bakış)

| Belirti | Bölüm | Para durumu |
|---|---|---|
| `pnpm smoke`: backend'e ulaşılamıyor | 2 | Etkilenmez (bekleyen işlem yok) |
| Peron "çevrimdışı" / `DEVICE_STALE` / `NO_DEVICE` | 3 | Yeni seans başlamaz, para hareket etmez |
| Müşteri başlattı, peron açılmadı (`ACK_TIMEOUT`) | 4 | Bloke otomatik iade edilir |
| Seans `RECONCILING`'de takılı | 5 | Bloke durur; 30 dk sonra otomatik kapanır |
| Denetim kuyruğunda seans (`needsReview`) | 6 | Otomatik para hareketi yok; karar yöneticide |
| "Para çekildi ama su gelmedi" | 7 | Yönetici bakiyeye iade eder |
| Kart yüklemesi bakiyeye geçmedi | 8 | Bakiye yalnız Iyzico'dan doğrulanan sonuçla yüklenir |
| İade talebi "belirsiz" (`IN_FLIGHT`) | 9 | **Tekrar deneme yok**, çift iade engelli |
| Postgres / Redis / Mosquitto container'ı düştü | 10 | Para kayıtları Postgres'te; bkz. bölüm |
| Elektrik kesildi, ESP32 yeniden başladı | 11 | Cihaz kaldığı yerden devam eder |
| Kayıtların bozulduğundan şüphe | 12 | Yedekten geri yükleme + mutabakat |

## 2. Backend cevap vermiyor

- **Bak:** süreç ayakta mı, `GET /api/v1/health`, backend log'u.
- **Yap:** backend'i yeniden başlat. Yeniden başlangıçta yarım kalan işler kendini toparlar: bekleyen START/STOP komutları outbox'ta durur, süresi dolan seanslar süpürme (sweep) ile kapanır.
- **Açılış sonrası:** broker, backend yeniden bağlanınca cihazın saklanan (retained) `DEVICE_STATUS` mesajını yeniden verir. Bu mesaj cihazın **şimdi** canlı olduğunu kanıtlamaz, bu yüzden `lastSeenAt`'i ilerletmez: kapalı bir cihazın peronu yeniden başlatma sonrası da "başlatılabilir" görünmez (`DEVICE_STALE`). Cihaz canlıysa ilk heartbeat'iyle (bosta en fazla 30 sn) peron açılır; bu kısa sürede QR ekranı "peron cihazından haber alınamıyor" gösterebilir.
- `pnpm smoke` `503 SERVICE_BUSY` görürse: aşırı yük (veritabanı bağlantı havuzu dolu), bkz. `docs/LOAD-TEST.md`. Bekle, tekrar dene; para etkilenmez.

## 3. Peron çevrimdışı (`OFFLINE`, `DEVICE_STALE`, `NO_DEVICE`)

`DEVICE_STALE`: cihazdan **90 sn**dir mesaj yok (bosta 30 sn, seansta 10 sn heartbeat).

1. Cihazın gücü ve Wi-Fi'si var mı? Röle kartı LED'i?
2. Mosquitto ayakta mı (`pnpm infra:up` / `docker ps`)? Cihaz broker'a TLS 8883 ile bağlanır; sertifika SAN'ı cihazın bağlandığı adresi içermelidir (`docs/SECURITY.md` §3.2).
3. Cihaz seans sırasında koptuysa **su akışı güvenlidir**: ESP32 süreyi kendi sayacında tutar ve süre dolunca röleyi kendi kapatır (`docs/IOT.md` §6). Seans bitiş bilgisi cihaz dönünce gelir.
4. Toparlanana kadar peronu **bakıma al** ki müşteri QR'da net bir durum görsün.

## 4. Başlattı ama açılmadı (`ACK_TIMEOUT`)

Backend `START` gönderir ve **10 sn** cihazdan `STARTED_ACK` bekler. Gelmezse seans `FAILED` olur, **bloke tamamen iade edilir**, peron `ERROR` durumuna alınır ve süren bir STOP komutu gönderilir (5 sn aralıkla, en çok 24 deneme, ~2 dk).

- **Yap:** cihaz/broker sorununu gider (bölüm 3). Peron `ERROR`'dan **kendiliğinden** çıkar: cihaz `ONLINE` durumu bildirince `IDLE`'a döner (elle bir şey gerekmez). Çıkmıyorsa cihaz gerçekten `ONLINE` bildirmiyordur; cihazın MQTT bağlantısına bak.
- **Geç gelen ACK** (`LATE_ACK`): cihaz iade edilmiş bir seansta çalıştığını bildirirse tahsil **edilmez**, seans `needsReview` olarak işaretlenir (bölüm 6).

## 5. Seans `RECONCILING`'de

Planlanan süre + 30 sn tolerans geçti ama cihaz bitiş bildirmedi. Bloke **durur**. Cihaz dönerse gerçek süre tahsil edilir. Dönmezse **30 dk** sonra yalnız **kanıtlanmış** süre tahsil edilir, kalan iade edilir, seans `needsReview` olur ve peron `ERROR`a alınır (cihaz kaybı).

- **Yap:** cihazı bul/onar (bölüm 3), sonra inceleme kuyruğundan seansı karara bağla (bölüm 6).

## 6. Denetim kuyruğu (`needsReview`)

Admin › **İnceleme**. Kuyruğa düşenler: cihaz kaybıyla otomatik kapanan seanslar, tahsil edilen süreden fazla kullanılan seanslar, iade edilmiş seansta çalışma (`UNPAID_RUN_REPORTED`). **Bu işaret para hareket ettirmez**; yalnız yöneticiyi uyarır.

- **Yap:** seans ayrıntısını aç (geçiş geçmişi, kullanılan/tahsil edilen süre), gerekçe yazarak incelendi olarak kapat. Müşteri haksız ödeme yaptıysa bölüm 7, fazla çekildiyse gerekçeli bakiye düzeltme (yalnız SUPER_ADMIN) kullan. Her adım değiştirilemez denetim kaydına (`AdminAuditLog`) yazılır.

## 7. "Para çekildi ama su gelmedi"

1. Admin › Kullanıcı ara › seansı bul; durumuna ve geçişlerine bak.
2. Teknik hata gerçekse seansta **Teknik hata iadesi** (`SERVICE_FAILURE`): tutar **bakiyeye** döner (Burak kararı 2026-09-26; ADMIN ve SUPER_ADMIN yapabilir). Kart iadesi değildir.
3. Bilerek eksik: seans zaten `FAILED`/tam iadeliyse ikinci iade yapılmaz; sistem çifte iadeyi reddeder.

## 8. Kart yüklemesi bakiyeye geçmedi

Müşteri Iyzico sayfasında ödedi ama bakiye artmadı. Bakiye **yalnız Iyzico'dan sorulan ve imzası doğrulanan sonuçla** yüklenir; callback, webhook ve mutabakat aynı anda gelse bile **tek** yükleme olur.

- **Yap:** önce bekle (mutabakat işçisi periyodik olarak Iyzico'yu sorgular, geç kalan webhook'ları da tamamlar). Hâlâ yoksa yüklemeyi Iyzico panelinde ara: ödeme başarılıysa mutabakatın işlemesini bekle; başarısızsa müşteriye söyle. Elle bakiye yazma: yalnız SUPER_ADMIN gerekçeli düzeltmesi, **ve önce Iyzico'da ödemenin gerçekten alındığını doğrula**.
- Hesap kapalıyken alınan ödeme `REVERSAL_PENDING`/`REVERSED` olur; Iyzico'da iptal/iade edilir.

## 9. İade talebi belirsiz sonuçta (`IN_FLIGHT`)

Kart iadesi Iyzico'ya gitmeden önce `IN_FLIGHT` olarak kalıcılaşır. Yanıt belirsizse (zaman aşımı) **otomatik yeniden deneme yoktur**: aynı iadenin iki kez gitmesi engellenir.

- **Yap:** Iyzico panelinde iadeye bak. Yapıldıysa admin panelinden "çözüldü" (resolve) ile kapat; yapılmadıysa, **panelde yapılmadığını doğruladıktan sonra** yeniden dene. Doğrulamadan asla tekrar başlatma.

## 10. Altyapı container'ı düştü

Yerel/pilot: `pnpm infra:up` (Postgres, Redis, Mosquitto). Veriler adlandırılmış volume'lerde durur; container'ı silmek veriyi silmez, **volume'ü silmek** siler.

| Servis | Düşerse | Toparlanma |
|---|---|---|
| **Postgres** | Backend hiçbir para işlemi yapamaz; başlatma `503`/hata döner. Yarım kalan para işlemi yok (işlemler atomik). | Container'ı kaldır, backend'i yeniden başlat, `pnpm smoke`. Veri bozulduysa bölüm 12. |
| **Redis** | Şu an **hiçbir şey ona bağlı değil** (hız sınırı backend belleğinde tutulur, `docs/SECURITY.md` §8 madde 7). Düşmesi bugün etkisizdir; ileride hız sınırı/kilit Redis'e taşınınca bu satır güncellenmeli. | Gerek yok. |
| **Mosquitto** | Cihazla komut/ACK akışı durur. Outbox komutları bekletir; ACK gelmeyen seans **10 sn**de iade edilir. | Broker'ı kaldır; cihazlar yeniden bağlanır (bölüm 3). |

## 11. Elektrik kesildi / ESP32 yeniden başladı

Seans bilgisi ve bitiş zamanı cihazın NVS belleğindedir; açılınca kalan süreyi okuyup seansı tamamlar. Donanım watchdog'u (15 sn) donmuş işlemciyi sıfırlar (`docs/IOT.md` §5–6). Backend tarafında cihaz dönene kadar seans `RECONCILING`'e geçebilir (bölüm 5).

## 12. Kayıt bozulması şüphesi

1. Backend'i durdur (yeni para işlemi yazılmasın).
2. Mevcut durumun yedeğini al: `pnpm db:backup`.
3. `pnpm db:restore-verify` ile **son yedeğin** sağlam ve mutabık olduğunu doğrula (geçici veritabanında).
4. Gerçek geri yükleme için `docs/DEPLOYMENT.md` §6 adımları. Yedek ile felaket arası işlemleri Iyzico panelinden ve kasa makbuzlarından elle karşılaştır.

## Bilinen boşluklar (bilerek açık)

- `docs/DEPLOYMENT.md` §3 `/health/db`, `/health/redis`, `/health/mqtt` uçlarını tarif eder ama **şu an yalnız `GET /health` vardır** (yalnız süreç canlılığı). Bağımlılık sağlığı ve alarm, Faz 7 "Gözlemlenebilirlik" maddesine aittir.
- Bu runbook'taki adımlar **gerçek cihaz ve gerçek Iyzico ile sahada denenmemiştir**; bölüm 3–5 kod ve `docs/IOT.md`'ye dayanır. Saha kurulumunda `pnpm smoke` ve bir gerçek seans denemesiyle doğrulanmalıdır.
