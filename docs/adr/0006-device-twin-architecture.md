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
