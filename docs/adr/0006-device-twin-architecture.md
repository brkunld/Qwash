# ADR-0006: IoT Cihaz Yönetimi — Device Twin ve Drift Tespiti

* **Durum:** Kabul Edildi
* **Tarih:** 2026-09-17
* **Karar Veren:** Proje Lideri

---

## Bağlam

IoT projelerinde sunucunun bildiği durum ile fiziksel sahadaki cihazın gerçek durumu her zaman aynı olmayabilir. Röle yapışabilir, 220V hattında arıza olabilir veya cihaz resetlenip eski duruma dönebilir.

Sistemin sahayı körü körüne yönetmesi yerine sahadaki gerçeklikle sunucu hedefini sürekli kıyaslaması gerekir.

## Karar

ESP32 peron donanımları için **Device Twin (Dijital İkiz)** deseni uygulanacaktır:

| Kavram | Açıklama | Örnek |
|---|---|---|
| **Desired State** | Sunucunun cihaza emrettiği durum | `relay: ON, session: RUNNING` |
| **Reported State** | Cihazın telemetriyle bildirdiği gerçek durum | `relay: ON, uptime: 120s` |
| **Drift Detection** | `Desired` ≠ `Reported` → tolerans (3 sn) sonrası hata | `DEVICE_DRIFT` alert |

## Gerekçe

| Kriter | Doğrudan Komut | Device Twin |
|---|---|---|
| Donanım arızası tespiti | Yok | Var (drift alert) |
| Komut/gerçeklik uyumsuzluğu | Fark edilmez | Saniyeler içinde tespit |
| Operasyonel yük | Düşük | Orta (telemetri işleme) |

## Sonuçlar

* Donanımsal arızalar (röle çekmemesi, elektrik kesilmesi) saniyeler içinde tespit edilir.
* Müşterinin çalışmayan makinede beklemesi engellenir.
* Backend tarafında her cihaz için ek durum takibi ve telemetri işleme yükü getirir.
* `DEVICE_DRIFT` hatası admin paneline otomatik bildirim gönderir.

## Uygulama (2026-09-26)

* **Desired** ayri saklanmaz: peronun aktif seansindan (`STARTING/RUNNING/RECONCILING`, `relayIndex`) turetilir; tek dogruluk kaynagi seans tablosudur.
* **Reported:** seans heartbeat'i (10 sn) `sessionActive`, `sessionId`, `remainingSec`, `relayIndex` (firmware 0.5.0+); bosta heartbeat 30 sn. Yalnizca perona bagli cihazin heartbeat'i degerlendirilir.
* **Drift turleri:** `UNEXPECTED_RUNNING` (aktif seans yokken calisma), `SESSION_MISMATCH` (baska seans), `NOT_RUNNING` (seans RUNNING, cihaz bosta), `RELAY_MISMATCH`.
* **Tolerans:** 3 sn yerine **15 sn**; heartbeat araligi 10-30 sn oldugundan 3 sn her ACK/heartbeat yarisini hata sayardi. Tolerans asilinca `Device.driftConfirmedAt` dolar ve ilgili seansa `DEVICE_DRIFT` gecisi yazilir. Uyum saglaninca temizlenir.
* **Aksiyon:** Para alinmayan calisma (`UNEXPECTED_RUNNING`, `SESSION_MISMATCH`) icin tolerans beklenmeden cihazin calistirdigi `sessionId` ile `STOP (DRIFT)` gonderilir, en fazla 5 sn'de bir. Firmware STOP'u yalnizca `sessionId` eslesirse uyguladigi icin yeni musterinin seansini kesmez. `NOT_RUNNING` icin STOP gonderilmez; para karari seans akisina (bitis/RECONCILING) kalir.
* **Sinir:** Rolenin fiziksel olarak cekip cekmedigi olculmuyor (akim/akis sensoru yok); `relayIndex` yazilimin bildirdigi durumdur. Admin bildirimi Faz 6.
