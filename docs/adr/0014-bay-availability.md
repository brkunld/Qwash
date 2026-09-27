# ADR-0014: Peron Hizmet Durumu (Bakim / Kapali) ve Cihaz Ekrani

- **Durum:** Kabul Edildi
- **Tarih:** 2026-09-28
- **Iliskili:** [ADR-0011](0011-admin-operations.md) #6 (bakim modu), [ADR-0013](0013-remote-device-config-and-ota.md) (cihaz ayari deseni), `IOT.md` 4.E, `API.md`

---

## Baglam

Bakim modu yalniz backend'de tutuluyordu: peron bakimdayken cihaz ekrani QR gostermeye devam ediyor, musteri okutup telefonda "peron bakimda" gorunce hayal kirikligina ugruyordu. Ayrica planli kapanis (gece, don riski, temizlik) ile ariza ayni seydi; kapali peron panelde sorun gibi gorunuyor, gece kapatmak icin peronlar tek tek bakima aliniyordu.

## Kararlar

### 1. Iki tur hizmet disi, ortak mekanizma (Burak, 2026-09-28)

- **MAINTENANCE:** plansiz, sorun. Ic sebep zorunlu (`reason`, yalniz admin gorur).
- **CLOSED:** planli. Ic not istege bagli. Panelde sorun rengiyle gosterilmez.

Ikisi de ayni alanlarda tutulur (`Bay.outOfService*`): yeni seans ve ekran bagi reddedilir, suren seans kesilmez (musteri odedigi sureyi kullanir). Iki turde de cihaz cevrimdisi alarmi uretilmez (gece cihaz kapatilabilir).

### 2. Ic sebep ve musteri notu ayri

`reason` ic nottur ("pompa arizasi, teknisyen cagrildi") ve ekrana cikmaz. `note` istege baglidir (en fazla 40 karakter), cihaz ekraninda ve QR sayfasinda gorunur ("15:00'te acilir"). Ic notun yanlislikla musteriye gorunmesini ayri alan onler.

### 3. Peron bazli + istasyonu toptan kapat/ac

`PUT /admin/stations/:id/availability`: CLOSED yalniz acik peronlari kapatir, OPEN yalniz KAPALI peronlari acar; bakimdaki peron iki durumda da bakimda kalir (bakim bilgisi kaybolmaz). Otomatik calisma saatleri sonraya birakildi.

### 4. Cihaza ADR-0013 deseniyle iletilir (SET_AVAILABILITY + rev)

Her degisiklikte `Bay.availabilityRev` artar ve durum `SET_AVAILABILITY { state, note, rev }` olarak **ayni transaction'da** outbox'a yazilir. Cihaz durumu NVS'e yazar (aginsiz acilista da QR gostermez) ve uyguladigi `rev`'i `DEVICE_STATUS` ve `HEARTBEAT` icinde bildirir; backend farkli gorurse yeniden gonderir. Boylece cihaz kapaliyken yapilan degisiklik, komut kaybolsa bile en gec bir heartbeat (30 sn) sonra ekrana yansir. `availRev` bildirmeyen eski firmware'e gonderilmez; panelde "cihaz ekrani guncel degil" gorunur (`AdminBayView.deviceInSync`).

Retained MQTT mesaji kullanilmadi: mevcut komut yolu (outbox, son kullanma, ACL) korunur ve durum kaynagi tek kalir (veritabani).

### 5. Ekran

Bosta ekranda QR yerine buyuk BAKIMDA (turuncu) veya KAPALI (gri), altinda not (2 satira kadar) ve peron kodu. Ekran fontu ASCII oldugu icin not backend'de sadelestirilir: Turkce harfler (noktasiz ı dahil) Latin karsiligina, buyuk harfe, 40 karaktere (`toScreenText`). Menu acikken peron hizmet disina alinirsa (seans yoksa) cihaz `MENU_EXIT` gonderip bagi birakir; seans surerken alinirsa seans bitince "tekrar sec" yerine hizmet disi ekrani gelir.

## Sonuclar

- Firmware 0.8.0 gerekir; eski cihazlarda durum yalniz backend'de uygulanir (QR sayfasi yine reddeder).
- `PUT /admin/bays/:id/maintenance` kaldirildi, yerine `PUT /admin/bays/:id/availability`. Eski denetim kayitlari (`BAY_MAINTENANCE_OFF`) okunur kalir; yenileri `BAY_OPENED`, `BAY_CLOSED`, `STATION_CLOSED`, `STATION_OPENED`.
