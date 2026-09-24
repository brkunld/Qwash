# QWASH — Proje Muhendislik Plani

## 1. Proje Vizyonu

QWASH; musteri web erisimi, IoT cihaz kontrolu, cuzdan tabanli odeme ve operator yonetimini tek sistemde birlestiren self-servis oto yikama otomasyon platformu olarak planlanmistir.

Urun; musterinin native mobil uygulama indirmeden peron QR kodunu okutmasini, bakiye yuklemesini, yikama seansini baslatmasini ve seans durumunu anlik takip etmesini hedefler.

> Mevcut durum: Bu repo su anda planlama ve muhendislik dokumantasyonu icermektedir. Uygulama gelistirmesi bu repoda henuz baslamamistir.

---

## 2. Urun Hedefleri

### Musteri Deneyimi

- Musteri servisi tarayici tabanli PWA uzerinden kullanabilir.
- QR okutma islemi musteriyi dogru istasyon ve perona baglar.
- Seans durumu, kalan sure ve tamamlanma bilgisi anlik olarak gosterilir.
- Odeme ve cuzdan akisi, istasyonda ilk kez gelen kullanici icin yeterince sade olur.

### Finansal Dogruluk

- Para degerleri float olarak degil, integer kurus olarak tutulur.
- Cuzdan hareketleri denetlenebilir ledger kayitlariyla temsil edilir.
- Kritik odeme ve seans islemleri idempotent tasarlanir.
- Veritabani constraintleri negatif bakiye ve gecersiz bloke durumlarini engeller.

### IoT Guvenilirligi

- Backend komutlari, kalici finansal tahsilattan once cihaz ACK mesaji ile dogrulanir.
- ESP32 cihazlari baglanti kaybi durumunda roleleri lokal olarak kapatabilir.
- Tekrarlanan MQTT mesajlari duplicate yan etki olusturmaz.
- Cihaz durumu desired/reported state karsilastirmasi ile izlenir.

### Operator Kontrolu

- Istasyon operatorleri peron durumunu, aktif seanslari ve cihaz sagligini gorebilir.
- Operator peronu bakim moduna alabilir.
- Manuel finansal islemler yetki ve audit kaydi ile sinirlandirilir.
- Production olaylari loglar, health checkler ve operasyon runbooklari ile analiz edilebilir.

---

## 3. MVP Kapsami

Ilk anlamli urun kilometre tasi, tek istasyon ve tek peron ile tam bir odemeli yikama akisini kanitlamalidir.

MVP kapsaminda olanlar:

- QR tabanli peron erisimi icin musteri PWA.
- Kullanici hesabi: e-posta/sifre ve Google girisi; misafir kullanim yok (ADR-0009).
- Iyzico sandbox ile tek TL cuzdan yukleme (kullanicinin ayri ayri kredi tipleri olmaz, tum servisler tek bakiyeden duser).
- Coklu yikama programi tarifesi (Su: 0.50 TL/sn, Kopuk: 1.00 TL/sn, Cila: 1.50 TL/sn, Hava: 0.75 TL/sn gibi admin tarafindan yonetilen saniyelik kurus birim fiyatlari).
- Tuketilen saniye basina dinamik cuzdan hold, capture ve release islemleri.
- Start/stop komut akisi ve coklu role secimi olan ESP32 kontrollu peron.
- ESP32 donanimsal MAC adresi ile tekil cihaz kimligi ve sahada kolay kurulum icin Wi-Fi Captive Portal (AP modu).
- Anlik seans durumu ve sure/bakiye geri sayimi.
- Peron, program tarifesi ve seans gorunurlugu icin admin ekrani.
- Finansal ve admin aksiyonlari icin temel audit trail.

MVP kapsaminda olmayanlar:

- Native iOS veya Android uygulamalari (karar: ADR-0008, PWA-first).
- Cok istasyonlu enterprise raporlama.
- Firmware OTA.
- Gelismis analitik veya makine ogrenimi.
- Coklu ulke veya coklu para birimi destegi.
- Karmasik microservices deployment yapisi.

---

## 4. Acik Non-Goals

Teslimati odakli tutmak icin asagidaki maddeler ilk surumden bilerek cikarilmistir:

- **Native mobil uygulamalar:** Ilk surum PWA kullanir (gerekce: [ADR-0008](adr/0008-pwa-first-client-strategy.md)); App Store ve Google Play surecleri ertelenir. Backend API'si istemciden bagimsiz tasarlandigi icin native uygulama sonradan eklenebilir.
- **Microservices:** Ilk surum operasyon ve deployment karmasikligini azaltmak icin modular monolith kullanir.
- **Multi-currency:** Ilk surum Turkiye ve TRY/kurus odaklidir.
- **Kafka veya event-store altyapisi:** Ilk urun asamasi icin PostgreSQL outbox ve Redis/BullMQ yeterlidir.
- **Makine ogrenimi ile fiyatlandirma:** Fiyatlandirma operator tarafindan yonetilen sabit veya kademeli degerlerle baslar.
- **Kurumsal audit genisletmeleri:** Hash-chain loglar ve ileri uyumluluk ozellikleri sonraki guclendirme adaylaridir.

---

## 5. Mimari Sinirlar

Uygulama gelistirilirken asagidaki kurallar korunmalidir:

- **PostgreSQL source of truth'tur:** Finansal, kullanici, peron, cihaz ve seans durumlari PostgreSQL'de kalici olarak tutulur.
- **Redis finansal veri kaynagi degildir:** Redis yalnizca cache, lock, queue ve gecici anlik durum icin kullanilabilir.
- **Para float tutulmaz:** Tum para degerleri integer kurus olarak saklanir.
- **Finansal islemler transactionaldir:** Cuzdan guncellemeleri ve ledger kayitlari atomik olarak commit edilir.
- **Idempotency zorunludur:** Kritik POST islemleri idempotency key veya esdeger duplicate korumasi ister.
- **Session state deterministiktir:** Seans gecisleri tanimli state machine uzerinden ilerler.
- **MQTT komutlari benzersizdir:** Komutlar benzersiz bir command ID tasir.
- **Cihaz mesajlari deduplicate edilir:** ACK ve telemetri mesajlari inbox pattern ile islenir.
- **Outbox dis yan etkileri korur:** Veritabani durum degisiklikleri ile disari gidecek eventler transactional outbox ile koordine edilir.
- **Cihaz kimligi kapsamla sinirlidir:** Cihazlar yalnizca atandiklari istasyon ve peron kapsaminda islem yapabilir.
- **Donanim fail-safe zorunludur:** Cihaz, baglanti kaybi durumunda yikamayi lokal olarak durdurabilmelidir.
- **Secrets Git'e girmez:** `.env.example` yalnizca placeholder degerler icerir.

---

## 6. Kalite Kapilari

Uygulama icin hedeflenen kalite akisi:

```text
Lint -> Typecheck -> Unit Tests -> Integration Tests -> Build -> Smoke Tests
```

Production'a dokunan isler merge edilmeden once minimum kontroller:

1. TypeScript strict kontrolleri gecer.
2. Lint kontrolleri gecer.
3. Unit testler cuzdan hesaplarini ve session state gecislerini kapsar.
4. Integration testler veritabani constraintlerini, cuzdan concurrency akisini ve outbox/inbox davranisini kapsar.
5. API kontratlari ortak semalarla dogrulanir.
6. Gercek secret degerleri commit edilmez.

---

## 7. Statik Dogrulama Gereksinimleri

Repo dogrulamalari sunlari kapsamalidir:

- JSON syntax dogrulamasi.
- YAML syntax dogrulamasi.
- Workspace ve package referans dogrulamasi.
- TypeScript config dogrulamasi.
- Turbo task dogrulamasi.
- Calisan veritabani gerektirmeden Prisma schema dogrulamasi.
- Docker Compose konfigürasyon dogrulamasi.
- Dokumantasyon link dogrulamasi.
- Secret taramasi.

---

## 8. Uygulama Durumu

| Alan | Durum |
|---|---|
| Urun ve mimari dokumantasyonu | Devam ediyor (Faz 0) |
| ADR'lar | 0001–0009 hazir |
| Monorepo konfigürasyonu | Baslamadi (Faz 1) |
| Cuzdan ve ledger | Baslamadi (Faz 2) |
| ESP32 firmware / donanim spike | Baslamadi (Faz 3) |
| Backend, seans ve IoT entegrasyonu | Baslamadi (Faz 4) |
| Odeme ve musteri PWA | Baslamadi (Faz 5) |
| Admin paneli | Baslamadi (Faz 6) |
| Pilot guclendirme, CI/CD, deployment | Planlandi (Faz 7) |

Faz sirasi ve gerekceleri icin [ROADMAP.md](ROADMAP.md) belgesine bakin.

Bu bolum, uygulama dosyalari eklendikce guncellenmelidir.
