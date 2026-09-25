# QWASH Peron Firmware (Faz 3 SPIKE)

Arduino IDE sketch'i: `firmware/qwash_bay/`. Kontrat `docs/IOT.md` ile birebir. Donanim: ESP32-32E, 3.2" ST7789 240x320 dirençli dokunmatik ekran modulu (SKU E32R32P).

> **Durum:** Iskelet yazildi ama **henuz derlenmedi ve cihazda denenmedi.** Ilk derleme/yukleme Burak'in Arduino IDE'sinde yapilacak. Beklenmedik derleme hatalari normaldir; hata metnini paylasin.

## Kurulum (Arduino IDE)

1. **Kart:** Boards Manager'dan `esp32` (Espressif) kur. Kart olarak `ESP32 Dev Module` sec. Partition: `Default 4MB with spiffs`. Upload speed: 460800 (olmazsa 115200).
2. **Kutuphaneler** (Library Manager):
   - `LovyanGFX` (lovyan03)
   - `PubSubClient` (Nick O'Leary)
   - `ArduinoJson` (Benoit Blanchon) — **v7**
   - `WiFiManager` (tzapu)
3. `firmware/qwash_bay/qwash_bay.ino` dosyasini ac, kartı bagla, yukle. Seri monitor: 115200.

## Wi-Fi ve ayar (Captive Portal)

Kayitli Wi-Fi yoksa cihaz `QWASH-AP-<MAC>` adli bir ag acar. Telefondan baglan; acilan sayfada Wi-Fi bilgisi, MQTT sunucu IP'si/portu, Istasyon ID, Peron ID ve QR taban adresi girilir. Ayarlar NVS'e yazilir, cihaz yeniden baslar. Portal **bloklamaz**: seans sirasinda Wi-Fi olmasa bile sayac ve roleler calisir.

## Dev broker'a baglanma

Dev Mosquitto varsayilan olarak yalniz `127.0.0.1`'e bagli (anonim erisim aciktir). ESP32'nin baglanabilmesi icin:

1. Qwash `.env` dosyasina `MQTT_BIND=0.0.0.0` ekle, `pnpm infra:up` ile yeniden olustur. **Yalniz guvendigin ag/ev Wi-Fi'inda yap;** broker sifresizdir.
2. Windows Guvenlik Duvari'nda TCP 11883 girisine izin ver.
3. Portalda MQTT sunucusuna bilgisayarin LAN IP'sini (`ipconfig`) ve port `11883` yaz.

## Role pinleri

`config.h` icinde `RELAY_PINS` varsayilan `{-1,-1,-1,-1}`: role bagli degil, firmware kuru calisir (log + ekran + MQTT). Kartin genisleme pinlerinden bos olanlari uretici semasindan dogrulayip doldur. Ilk gercek denemede role yerine LED/multimetre kullan; 220V baglantisi ehliyetli kisi yapmali.

## Elle test (broker'a komut gonderme)

Docker'daki broker'a bilgisayardan (topic'te MAC degil, portalda girdigin istasyon/peron ID kullanilir).

> **Git Bash kullan, Windows PowerShell 5.1 degil.** PowerShell `-m` ile gecilen JSON'daki tirnaklari siler, stdin'den pipe edilince de basina UTF-8 BOM ekler; iki durumda da cihaz mesaji gecersiz JSON diye reddeder (2026-09-25'te cihazda goruldu).

```bash
# START: 30 sn, role 1
docker exec qwash-dev-mosquitto-1 mosquitto_pub -q 1 -t "qwash/station/STATION-01/bay/BAY-001/cmd" -m '{"commandId":"11111111-1111-4111-8111-111111111111","sessionId":"22222222-2222-4222-8222-222222222222","payload":{"type":"START","program":"WATER","relayIndex":1,"durationSec":30}}'

# ACK ve olaylari izle
docker exec qwash-dev-mosquitto-1 mosquitto_sub -v -t "qwash/station/STATION-01/bay/BAY-001/#"

# Ayni START'i tekrar gonder: role degismemeli, ACK "DUPLICATE" veya "SUCCESS" gelmeli.
# STOP:
docker exec qwash-dev-mosquitto-1 mosquitto_pub -q 1 -t "qwash/station/STATION-01/bay/BAY-001/cmd" -m '{"commandId":"33333333-3333-4333-8333-333333333333","sessionId":"22222222-2222-4222-8222-222222222222","payload":{"type":"STOP","reason":"USER_STOP"}}'
```

## Faz 3 kabul kontrolu

Ilk cihaz olcumu (2026-09-25, kuru calisma, ev Wi-Fi'i, RSSI -43): START→STARTED_ACK ~265 ms (`docker exec` acilisi dahil); ayni `commandId` tekrarinda sayac sifirlanmadi; 20 sn'lik seans 20 sn'de `SESSION_ENDED/COMPLETED` uretti.

- [x] START rolei ceker (kuru calismada log basar), sure dolunca kapatir. _(kuru calismada dogrulandi; gercek role bekliyor)_
- [x] Ayni `commandId` ikinci kez gelince role tekrar cekilmez.
- [x] Komut-ACK gecikmesi olculur (~265 ms).
- [x] Sure ortasinda Wi-Fi/broker kesilse de sure dolunca role kapanir. _(2026-09-25: 60 sn seansta erisim noktasi kapatildi; sayac durmadan bitti, `BITTI` goruldu, broker LWT ile `OFFLINE` yayinladi. Cevrimdisi biten seansin `SESSION_ENDED` olayi o an kaybolur; fw 0.2.0 son bitisi NVS'te tutup her baglantida yeniden gonderir.)_
- [x] Sure ortasinda guc cekilip takilinca kalan sureyle devam eder, `SESSION_RECOVERED` olayi gelir. _(2026-09-25: gecti. Burak fisi bilerek 3 kez cekti; 90 sn seans duvar saatiyle 129 sn surdu (her kesintide kapali kalinan sure + son NVS kaydindan bu yana gecen sure sayilmaz). NVS kayit araligi 10→3 sn yapildi, reset sebebi olaylara eklendi.)_
- [x] `durationSec` > 3600 veya 0, gecersiz `relayIndex` (0, 5), seans surerken ikinci START (`BUSY`) reddedilir; `commandId`siz ve JSON olmayan mesaj yok sayilir; STOP seansi kapatir, ikinci STOP `NOT_ACTIVE`. _(2026-09-25)_
- [x] Suresi dolmus (`expiresAt` gecmis) START reddedilir (`EXPIRED`). _(2026-09-25: saat senkronken dogrulandi. Saat senkron degilken kontrol yapilamaz; asil koruma Faz 4 "gec ACK kurali".)_
- [x] Bosta ekranda QR + peron kodu, seansta kalan sure + `CALISIYOR`/`BITTI`. _(2026-09-25: QR telefonla okutuldu, yer tutucu adrese gitti.)_
- [x] NTP modemde calisir (Windows mobil erisim noktasinda calismamisti); zaman damgalari gercek. _(2026-09-25)_
- [x] Seans basinda `BUSY`, sonunda `ONLINE` durumu yayinlanir; `resetReason` durum mesajinda gorunur. _(2026-09-25, 4d605e8)_

## Surum notlari

- **0.2.0-spike (2026-09-25):** STOP yalnizca `sessionId` eslesirse uygulanir. Son biten seans NVS'te tutulur ve her MQTT baglantisinda yeniden gonderilir. Seans surerken heartbeat 10 sn'de bir gider ve `sessionId` + `remainingSec` icerir (backend'in kanitlanmis kullanim hesabi, ADR-0010 #8). Cihazda dogrulandi: normal seansta heartbeat ile kanitlanmis sure artti; seans sirasinda broker durdurulunca bitis bilgisi broker donunce ulasti ve seans gercek sureyle kapandi.
- **0.2.1-spike (2026-09-25):** Broker seans sirasinda durdurulunca cihaz Task WDT (`resetReason` 6) ile yeniden basliyordu: Docker'in port yonlendirmesi TCP'yi kabul edip CONNACK vermedigi icin PubSubClient baglanmayi 15 sn (varsayilan) bekliyordu. `setSocketTimeout(3)` ile duzeltildi. `SESSION_RECOVERED` artik kurtarilan `sessionId` ve o anki kalan sureyi her zaman tasir (seans cevrimdisiyken bitmis olsa bile). **Cihazda henuz denenmedi.**
- **0.2.2-spike (2026-09-25):** MQTT keepalive 15 sn'den 30 sn'ye cikarildi (`setKeepAlive(30)`). Zayif Wi-Fi'da (RSSI -76) broker 22,5 sn sessizlikte `exceeded timeout` ile baglantiyi dusuruyordu; yeni tolerans 45 sn ve backend `deviceStaleMs` (90 sn) altinda. **Cihaza yuklenip denenmedi.**
- **0.3.0-spike (2026-09-26):** Broker artik anonim baglantiyi reddediyor. Cihaz kullanici adi olarak `deviceId` (MAC), sifre olarak portalda girilen `MQTT sifre` alanini kullanir (NVS `mqttPass`; bos birakilirsa mevcut sifre korunur, portalda gosterilmez). Broker ACL'i cihazi yalnizca kendi peronunun topic'lerine sinirlar (`docker/mosquitto/acl`). Gelistirmede sifre `secrets.h`den gelir (git disi, `secrets.h.example`); portaldan girilen sifre NVS'te onceliklidir. Portal yalnizca Wi-Fi baglanamazsa acilir. **Bilinen sinir:** kurulum AP'si sifresiz; fiziksel erisimi olan biri ayarlari degistirebilir (TLS adiminda ele alinacak).
- **0.4.0-spike (2026-09-26):** MQTT TLS. Cihaz broker'a `WiFiClientSecure` ile 18883'ten baglanir ve sunucu sertifikasini `mqtt_ca.h` icindeki gelistirme CA'siyla dogrular (`pnpm mqtt:certs` uretir, git disi; sertifika SAN'i `.env` `MQTT_TLS_SANS`). TCP 3 sn + el sikismasi 6 sn, 15 sn WDT altinda. Port NVS anahtari `mqttTlsPort` oldu (eski 11883 kaydi kullanilmaz). Kurulum AP'si artik sifreli (`secrets.h` `DEFAULT_AP_PASS`). Duz 11883 yalniz bilgisayarin kendisine acik.

## Bilinen sinirlar (spike)

- Guc kesilince kurtarilan sure, son NVS kaydindaki (en fazla 3 sn onceki) kalan sureden devam eder; kesinti suresi sayilmaz (RTC yok). Sunucu mutabakati (Faz 4) bunu duzeltir.
- MQTT su an sifresiz/TLS'siz (yalniz dev). TLS, cihaz kimligi ve ACL Faz 4'te.
- Wi-Fi koparsa cihaz 15 sn'de bir kayitli aga yeniden baglanmayi dener (core'un auto-reconnect'i AP tamamen kaybolunca vazgeciyordu; 2026-09-25'te cihazda goruldu). Portal ise kendiliginden yeniden acilmaz; ag bilgisi degistiyse cihaz yeniden baslatilmali.
- QR taban adresi (`https://qwash.example/b/`) yer tutucudur.
- WDT sifirlamasinda GPIO'lar kisa sure kayan olabilir; gercek role kartinda pull-down ile guvenli konuma cekilmesi donanim tarafinda kontrol edilmeli.
