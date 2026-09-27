# QWASH — Donanım Doğrulama Kaydı (Faz 3 spike → Faz 7)

Bu belge, peron cihazının **gerçek donanımda neyin denendiğini ve neyin denenmediğini** kaydeder. Yalnızca gözlenen sonuçlar yazılır; denenmeyenler açıkça "denenmedi" diye işaretlidir. Sahaya çıkmadan önce "Denenmedi" bölümü kapatılmalıdır.

## Cihaz

| | |
|---|---|
| Modül | ESP32E 3.2" ST7789 IPS 240x320, dirençli dokunmatik (XPT2046), SKU **E32R32P** (ESP32-32E) |
| Cihaz kimliği | `4CC382C3CC1C` (MAC), `STATION-01` / `BAY-001` |
| Firmware | 0.5.0 (spike) → 0.6.0 (dokunmatik menü) → 0.7.0 (OTA) → **0.7.1** (şu an cihazda) |
| Derleme | Arduino IDE'nin arduino-cli 1.5.1 + esp32 çekirdeği 3.3.8, bölüm şeması `Minimal SPIFFS (1.9MB APP with OTA)` |
| Röle | **Bağlı değil** (`RELAY_PINS = -1`, kuru çalışma): tüm denemelerde röle yerine log/ekran kullanıldı |

## Gerçek cihazda doğrulananlar

| Tarih | Ne | Sonuç | Kaynak |
|---|---|---|---|
| 2026-09-25 | START → ACK gecikmesi | ~265 ms | Faz 3 cihaz testi (`firmware/README.md`) |
| 2026-09-25 | Tekrarlanan `commandId` | Yan etki yok (idempotent) | Faz 3 |
| 2026-09-25 | Ağ kesilince sayaç | Cihaz süreyi kendi sayıp bitirdi; broker LWT ile `OFFLINE` yayınladı | Faz 3 |
| 2026-09-25 | Wi-Fi geri gelince | 15 sn'lik yeniden denemeyle bağlandı | Faz 3 |
| 2026-09-25 | Güç kesilip gelince | NVS'ten kalan süreyle devam etti | Faz 3 |
| 2026-09-26 | Cihazın backend'de görünmesi | `ONLINE`, fw 0.5.0-spike, peron listesinde ve `pnpm smoke`'ta sağlıklı | Faz 7 smoke testi |
| 2026-09-27 | Dokunmatik ekran | Kalibrasyondan sonra dokunuşlar doğru yere düştü; paket → süre → başlat → DURDUR | ADR-0012, PR #27 |
| 2026-09-27 | Ekrandan seans ve tahsilat | 120 sn planlı, 10 sn kullanıldı → 5,00 TL; ikinci denemede 20 sn → 10,00 TL; bloke kalmadı | ADR-0012 |
| 2026-09-27 | 30 sn "tekrar seç" sonra QR | Bağ süresi dolunca ekran QR'a döndü | ADR-0012 |
| 2026-09-27 | Telefondan QR ile bağlama | Bağla / bırak / tekrar bağla / ekrandan seans çalıştı | PR #28 |
| 2026-09-27 | QR adresinin uzaktan eşlenmesi | Cihaz eski adresi bildirdi, `SET_CONFIG` ile `http://192.168.1.7:3000/b/` oldu | ADR-0013, PR #29 |
| 2026-09-27 | Seans sürerken OTA reddi | `BAY_IN_USE` (backend) | ADR-0013 |
| 2026-09-27 | **Kablosuz firmware güncellemesi** | 0.7.0 → 0.7.1: indirme ~6 sn, yeniden başlama, 60 sn sağlık sonrası `SUCCEEDED` | ADR-0013 |
| 2026-09-27 | Yanlış imzalı imaj | Cihaz reddetti (`FAILED SIGNATURE`), 0.7.1'de kaldı | ADR-0013 |

## Cihaz denemelerinde bulunan ve düzeltilen hatalar

- **Ekrandan DURDUR sonrası bitiş bildirimi kayboldu** (`SESSION_ENDED` QoS 0): seans `RECONCILING`'de kaldı, peron kilitlendi. Cihaz bitişi yalnız MQTT yeniden bağlanınca tekrar gönderiyordu. **Düzeltme (0.7.1):** bitiş 2 dk boyunca her heartbeat'le yeniden gönderilir. Doğrulama: düzeltmeli sürüm OTA ile gitti; düzeltmeden sonra aynı senaryo bu kayıtta **tekrar denenmedi**.
- **Kalibrasyonsuz dokunuşlar** yanlış yere düşüyordu: açılışta ekrana basılı tutarak kalibrasyon eklendi (`firmware/README.md`).
- **"KALIBRE EDILDI" yazısı** 320 px'e sığmayıp bir harfi kesiyordu: metin uzunluğuna göre punto küçülür (`10dee53`).
- **USB:** kart bir bilgisayar USB girişinde CH340 çipiyle veri taşımadı ("No serial data received"); başka girişte (COM9) çalıştı. Yükleme sorununda önce kabloyu/girişi değiştirin.

## Bilinen sınırlar (Faz 3'ten)

- Kapalı kalınan süre sayılmaz (RTC yok); güç kesilirse kalan süre NVS'ten yüklenir.
- Çevrimdışıyken üretilen olaylar kaybolur (yalnız son seans bitişi NVS'te tutulur ve yeniden gönderilir).
- NTP, Windows erişim noktası üzerinden senkron olmadı (cihaz saati olmadan `timestamp` gönderilmez).

## Denenmedi (sahaya çıkmadan kapatılmalı)

1. **Gerçek röle ve gerçek su akışı.** Röle kartı yok; pinler (`RELAY_PINS`) ve `RELAY_ACTIVE_HIGH` doğrulanmadı. Şu ana kadar hiçbir seansta fiziksel bir şey açılıp kapanmadı. İlk denemede röle yerine LED/multimetre kullanın (`config.h`).
2. **Güç kesintisinde seans kurtarma, 0.6.0 ve sonrasında.** Faz 3'te 0.5.0 ile denendi; dokunmatik menü ve OTA eklendikten sonra tekrar denenmedi.
3. **OTA'da 3 açılışta eski sürüme dönüş.** Kod yolu var; bozuk ama imzalı bir imaj gerektirdiği için denenmedi.
4. **Wi-Fi gücü zayıf sahada** (RSSI, keepalive toleransı): yalnız masa başı ağında denendi.
5. **Sahadaki gerçek ağ:** MQTT TLS sertifikasının SAN'ı ve alan adıyla çalışma (şu an LAN IP'si).
6. **Uzun süreli çalışma** (saatler/günler): bellek sızıntısı, WDT sıfırlamaları gözlenmedi.
7. **Dokunmatik ekranın ıslak/eldivenli kullanımı:** dirençli ekran sertçe basış ister; sahada kullanılabilirliği test edilmedi.
