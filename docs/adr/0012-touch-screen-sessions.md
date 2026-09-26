# ADR-0012: Dokunmatik Ekrandan Seans (Peron Bagi)

- **Durum:** Kabul Edildi
- **Tarih:** 2026-09-27
- **Iliskili:** [ADR-0007](0007-session-state-machine-and-two-phase-ack.md), [ADR-0010](0010-session-flow-implementation.md), `IOT.md` 4.D

---

## Baglam

Burak'in istegi (2026-09-27): QR okutulunca peronun dokunmatik ekraninda o peronun paketleri gorunsun; musteri pakete, sonra sureye dokununca yikama **telefona gerek kalmadan** baslasin; seans surerken ekranda DURDUR olsun; sure bitince ~30 sn beklesin, yeni paket secilmezse ekran otomatik QR'a donsun.

Sorun: seanslar musterinin cuzdanindan odenir; ekrandan yapilan secimin kimin parasiyla yapildigi bilinmeli. Burak'in karari: musteri QR'i **bir kez** okutup telefonda onaylar, peron ekrani kisa sureligine onun hesabina baglanir, para bakiyesinden cekilir. Sure secimi hazir dugmelerle yapilir.

## Kararlar

### 1. Peron bagi (`BayClaim`), seans degil

Telefonda peron onaylaninca (`POST /bays/:bayCode/claim`) bir `BayClaim` (ACTIVE) acilir ve cihaza `SHOW_MENU` gider. Bir peronda ayni anda tek ACTIVE bag olur (kismi benzersiz indeks). Bag acikken baska musteri o perona ne baglanabilir ne de telefondan baslatabilir (`BAY_CLAIMED`). Ayni musteri tekrar baglanirsa ayni bag yenilenir.

Sureler: ilk secim icin 90 sn; seans bitince 30 sn ("tekrar sec"); ekrandan baslatilan seans ACK beklerken 60 sn. Seans surerken bag kapanmaz. Suresi dolan bag tarama ile `EXPIRED` olur ve cihaza `SHOW_QR` gider; cihaz ayni sureyi kendi de sayar (ag yoksa da QR'a doner).

### 2. Para yolu degismez

Cihaz yalniz "hangi paket, kac saniye" der (`MENU_START`). Backend bagi dogrular (ACTIVE, suresi dolmamis, olayin geldigi topic bagin peronu) ve seansi **bagli musteri adina** `SessionService.start` ile acar: ayni HOLD, ayni two-phase ACK, ayni tahsilat. Tutar ve bakiye kontrolu backend'dedir; ekrandaki "bakiye yetersiz" yalniz kolaylik.

Idempotency: cihaz her secim icin bir `requestId` uretir; seans anahtari `userId:screen:claimId:requestId`. Ayni dokunus mesaji tekrar gelirse (QoS 0 yeniden gonderim, cift dokunma) ikinci HOLD olmaz. Ayrica `eventId` gelen kutusuyla tekrarlar elenir.

Hata (yetersiz bakiye, peron mesgul...) seans acmaz; cihaza `MENU_ERROR` gider ve bag 30 sn uzar.

### 3. DURDUR cihazda

Ekrandaki DURDUR roleyi **cihazda hemen** kapatir ve `SESSION_ENDED` (`reason: SCREEN_STOP`, `remainingSec`) bildirir. Tahsilat mevcut yoldan, bildirilen kalan sureyle yapilir. Gerekce: su aninda kesilir ve ag yokken de calisir (bildirim baglaninca gider). Ayri bir "durdurma istegi" olayi eklenmedi. Durdurmak yalniz odenecek tutari azaltir, para yaratmaz; dugmeye basan fiilen peronun onundedir.

### 4. Ekran metni

Ekran fontu yalniz ASCII basar. Backend paket adlarini sadelestirip (Turkce harf -> ASCII, BUYUK harf, 16 karakter) gonderir. Ekranda musterinin dogru hesap oldugunu gormesi icin maskeli e-posta (`BU***@GMAIL.COM`) ve kullanilabilir bakiye gorunur.

## Sonuclar

- Musteri QR'dan sonra telefona dokunmadan yikayabilir; telefon acik kalirsa ekrandan baslatilan seansa kendiliginden gecer.
- **Bilerek kabul edilen risk:** bag acikken peronun onundeki herkes o hesaptan secim yapabilir. Sinirlama: kisa sureler, ekranda maskeli hesap etiketi ve bakiye, telefonda "Birak" dugmesi, ekranda "Cikis". Harcanabilecek tutar musterinin kendi bakiyesiyle sinirli.
- Bag ile baska musterinin telefondan baslatmasi arasinda cok kisa bir yaris penceresi var (bag peron satirini kilitler, baslatma kilitlemez). Sonuc en kotu ihtimalle "PERON MESGUL" mesajidir; para guvenligi seans tablosunun "peronda tek aktif seans" indeksiyle korunur.
- Firmware 0.6.0: XPT2046 dokunmatik (CS 33, ekranla ortak SPI), kalibrasyon acilista ekrana basili tutarak. Uygulama alani buyudu; bolum semasi `Minimal SPIFFS` olmali (`firmware/README.md`).
