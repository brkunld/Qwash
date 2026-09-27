# ADR-0013: Cihaza Uzaktan Ayar ve Imzali Firmware Guncellemesi (OTA)

- **Durum:** Kabul Edildi
- **Tarih:** 2026-09-27
- **Iliskili:** [ADR-0006](0006-device-twin-architecture.md), [ADR-0012](0012-touch-screen-sessions.md), `IOT.md` 4.E, `firmware/README.md`

---

## Baglam

Peron cihazi (ESP32) monte edildikten sonra her degisiklik icin USB kablosuyla cihaza gitmek gerekiyordu. Dokunmatik ekran denemesinde kucuk bir yazi hatasi icin bile yeniden yukleme yapildi. Ayrica ekrandaki QR adresi (`https://qwash.example/b/`) yalniz cihazin kurulum portalindan degisiyordu; portal ise yalniz Wi-Fi baglanamazsa aciliyor. Alan adi gelince her cihaza dokunmak gerekecekti.

Tehdit: firmware roleleri, yani suyu ve parayi kontrol eder. Uzaktan guncelleme, ele gecirilmis bir sunucunun ya da admin hesabinin tum cihazlara zararli kod gondermesine yol acmamali.

## Kararlar

### 1. QR adresi kendiliginden eslenir (SET_CONFIG)

Cihaz baglaninca `DEVICE_STATUS` icinde kullandigi `qrBase`'i bildirir. Backend bunu olmasi gerekenle karsilastirir (`DEVICE_QR_BASE`, bossa `<CUSTOMER_APP_URL>/b/`); farkliysa `SET_CONFIG` gonderir. Cihaz adresi dogrular (http/https, `/` ile biter), NVS'e yazar, durumunu yeniden bildirir. Alan adi degisince yalniz `.env` degisir. `qrBase` bildirmeyen eski firmware'e komut gonderilmez.

Istasyon/peron kimligi ve MQTT sunucusu bu yolla degistirilmez: yanlis deger cihazi kalici olarak kopartir (ACL, sertifika), bunlar sahada portal isidir.

### 2. Imza cihazda dogrulanir; sunucu imzalayamaz

Imza anahtari (ECDSA P-256) operatorun bilgisayarinda uretilir (`pnpm firmware:keys`). Ozel anahtar **sunucuya konmaz**; acik anahtar firmware'e gomulur (`ota_pubkey.h`). Surecin adimlari:

1. `pnpm firmware:sign <imaj.bin>`: ozel anahtarla imza (imajin SHA-256'si uzerinde, DER, base64).
2. `pnpm firmware:publish <imaj.bin> <surum>`: backend imzayi acik anahtarla dogrular, imajin icinde surum metni oldugunu kontrol eder, `FIRMWARE_DIR`'e kopyalar.
3. `pnpm firmware:rollout <PERON> <surum>`: cihaza `OTA` komutu.

Cihaz imaji yazarken SHA-256 hesaplar; hash ve imza tutmazsa `Update.abort()` ile yeni imaj asla acilmaz. Boylece sunucu, veritabani ya da admin ele gecirilse bile imzasiz kod cihaza giremez; yalniz imzali eski bir surume dusurme mumkundur (kabul edilen risk, asagida).

### 3. Indirme baglantisi tek cihaza ozel ve kisa omurlu

Imajda derleme sirasindaki sirlar olabilir (gelistirme MQTT sifresi, kurulum AP sifresi), bu yuzden imaj herkese acik indirilemez. `OTA` komutu 32 baytlik rastgele bir anahtar tasir (MQTT TLS + ACL: yalniz o cihaz okur); veritabaninda yalniz SHA-256'si tutulur, 15 dk gecerlidir ve guncelleme yeniden baslama asamasina gecince kapanir. `GET /api/v1/firmware/download/:token` giris istemez, dakikada 10 istekle sinirlidir, bilinmeyen anahtara 404 verir.

Tasima: https adreslerinde TLS sertifikasi dogrulanmaz (`setInsecure`), cunku butunluk imzayla saglanir. Gizlilik icin canlida cihaz sirlari imaja gomulmemeli (MQTT sifresi portaldan NVS'e) ya da sertifika paketi eklenmeli (sonraki is).

### 4. Guvenli an ve geri donus

- Cihaz seans suruyorsa veya ekran bir musteriye bagliysa `OTA`'yi reddeder (`BUSY`); backend de peronda seans/bag varken komut gondermez. Guncelleme sirasinda cihaz `UPDATING` bildirir, peron kullanilamaz gorunur.
- Yeni surum, MQTT'ye baglanip 60 sn calisana kadar "deneme"dir. Bu kosul saglanmadan 3 kez acilirsa (cokme, WDT, baglanamama) cihaz onceki bolume doner ve `ROLLED_BACK` bildirir. Bu uygulama seviyesinde yapilir; Arduino'nun hazir bootloader'ina bagli degildir.
- Backend `OTA_STATUS` bildirimleriyle kaydi gunceller (`DOWNLOADING`, `REBOOTING`, `SUCCEEDED`, `FAILED`). 15 dk icinde bitmeyen guncelleme, cihazin bildirdigi surume gore basarili ya da `TIMEOUT` olarak kapanir.
- Bolum semasi `Minimal SPIFFS (1.9MB APP with OTA)`: iki uygulama bolumu var.

## Sonuclar

- Alan adi gelince QR icin `.env` yeterli; firmware duzeltmeleri kabloya gerek kalmadan gider.
- **Ozel anahtar kaybolursa** sahadaki cihazlar uzaktan guncellenemez (yeni anahtarli firmware USB ile yuklenmeli). Yedeklenmeli.
- **Kabul edilen risk:** imzali eski bir surume dusurme (surum numarasi zorunlu artmiyor). Surum karsilastirmasi sonraki is.
- Rollout simdilik komut satirindan; admin paneli ekrani sonraki is.
