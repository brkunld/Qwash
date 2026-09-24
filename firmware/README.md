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

Docker'daki broker'a bilgisayardan (topic'te MAC degil, portalda girdigin istasyon/peron ID kullanilir):

```powershell
# START: 30 sn, role 1
docker exec qwash-dev-mosquitto-1 mosquitto_pub -q 1 -t "qwash/station/STATION-01/bay/BAY-001/cmd" -m '{"commandId":"11111111-1111-4111-8111-111111111111","sessionId":"22222222-2222-4222-8222-222222222222","payload":{"type":"START","program":"WATER","relayIndex":1,"durationSec":30}}'

# ACK ve olaylari izle
docker exec qwash-dev-mosquitto-1 mosquitto_sub -v -t "qwash/station/STATION-01/bay/BAY-001/#"

# Ayni START'i tekrar gonder: role degismemeli, ACK "DUPLICATE" veya "SUCCESS" gelmeli.
# STOP:
docker exec qwash-dev-mosquitto-1 mosquitto_pub -q 1 -t "qwash/station/STATION-01/bay/BAY-001/cmd" -m '{"commandId":"33333333-3333-4333-8333-333333333333","sessionId":"22222222-2222-4222-8222-222222222222","payload":{"type":"STOP","reason":"USER_STOP"}}'
```

## Faz 3 kabul kontrolu

- [ ] START rolei ceker (veya kuru calismada log basar), sure dolunca kapatir.
- [ ] Sure ortasinda Wi-Fi/broker kesilse de sure dolunca role kapanir.
- [ ] Sure ortasinda guc cekilip takilinca kalan sureyle devam eder, `SESSION_RECOVERED` olayi gelir.
- [ ] Ayni `commandId` ikinci kez gelince role tekrar cekilmez.
- [ ] `durationSec` > 3600 veya gecersiz `relayIndex` reddedilir.
- [ ] Komut-ACK gecikmesi olculur (hedef < 5 sn, gercekte cok daha dusuk olmali).
- [ ] Bosta ekranda QR + peron kodu, seansta kalan sure + `CALISIYOR`/`BITTI`.

## Bilinen sinirlar (spike)

- Guc kesilince kurtarilan sure, son NVS kaydindaki (en fazla 10 sn onceki) kalan sureden devam eder; kesinti suresi sayilmaz (RTC yok). Sunucu mutabakati (Faz 4) bunu duzeltir.
- MQTT su an sifresiz/TLS'siz (yalniz dev). TLS, cihaz kimligi ve ACL Faz 4'te.
- Wi-Fi seans disinda koparsa portal otomatik yeniden acilmaz; cihaz yeniden baslatilinca acilir.
- QR taban adresi (`https://qwash.example/b/`) yer tutucudur.
- WDT sifirlamasinda GPIO'lar kisa sure kayan olabilir; gercek role kartinda pull-down ile guvenli konuma cekilmesi donanim tarafinda kontrol edilmeli.
