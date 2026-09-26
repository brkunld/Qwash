# QWASH — Muhendislik Roadmap'i

Bu roadmap, projenin once **en buyuk riskleri erken kanitlayan** bir cekirdege, sonra pilot hazirligina ulasmasini hedefler. Her faz yalnizca dokuman degil, dogrulanabilir bir teslimat uretmelidir.

> Mevcut durum: Proje dokumantasyon ve mimari planlama asamasindadir. Uygulama kodu henuz yoktur. Bu roadmap, faz sirasini gozden gecirmis (2026-09-24) son halidir.

---

## Teslimat Prensipleri

| Prensip | Anlami |
|---|---|
| Riski once kanitla | En pahali yanlislar para ve donanimdadir. Ikisi de gercek entegrasyondan once ayri ayri, izole olarak kanitlanir. |
| Para guvenligi cekirdektir | Cuzdan, ledger, idempotency ve DB kurallari sonradan eklenen detay degildir. Seans mantigi ledger'in uzerine kurulur, tersi degil. |
| Guvenlik faza gomulur | Webhook dogrulama, MQTT cihaz kimligi ve yetkilendirme ilgili fazin tamamlanma kriteridir. Pilot oncesine birakilmaz. |
| Once MVP, sonra olcek | Cok istasyona gecmeden once tek peron akisi calismalidir. |
| Atilabilir prototip acikca etiketlenir | Sonradan yeniden yazilacak kod "spike" diye adlandirilir ve ana koda karismaz. |
| Karmasiklik fazlandirilir | OTA, MFA, native uygulama gibi ozellikler MVP kanitlandiktan sonra ele alinir. |

---

## Faz Ozeti ve Bagimliliklar

```text
Faz 0 Dokumantasyon
   │
Faz 1 Monorepo Temeli
   ├────────────────────────┐
Faz 2 Cuzdan & Ledger     Faz 3 Donanim Spike (paralel yapilabilir)
   │                        │
   └───────────┬────────────┘
        Faz 4 Seans + IoT Entegrasyonu (state machine, two-phase ACK, outbox/inbox)
               │
        Faz 5 Odeme (Iyzico) ve Musteri PWA
               │
        Faz 6 Admin Operasyonlari
               │
        Faz 7 Pilot Guclendirme
```

Faz 2 ve Faz 3 birbirinden bagimsizdir; iki kisi veya iki paralel calisma akisi varsa ayni anda yurutulebilir. Ikisi de bitmeden Faz 4'e gecilmez.

---

## Faz 0: Dokumantasyon ve Mimari Temel

**Hedef:** Kodlamaya baslamadan once kapsam, karar ve sinirlarin tutarli olmasi.

- [x] Urun vizyonu ve kapsam dokumante edildi.
- [x] Temel mimari kararlar ADR olarak yazildi (0001–0008).
- [x] IoT, API, veritabani, guvenlik ve test yonu dokumante edildi.
- [x] Istemci stratejisi kararlastirildi: PWA-first (ADR-0008).
- [x] Musteri kimlik dogrulama karari: e-posta/sifre + Google, misafir yok (ADR-0009).
- [x] Tarife karari: fiyatlari admin belirler; baslangic (seed) degerleri ornek olarak verilir.
- [x] Belge linkleri kontrol edildi (2026-09-25, kirik link yok).
- [x] Peron QR'i ekranda gosterilecek, basili etiket degil (QR-jacking riski, `IOT.md`).
- [ ] Acik sorulardan Faz 1 oncesi kapanmasi gerekenler kapatildi (asagida "Acik Sorular").

**Tamamlanma Kriterleri**
- Yeni bir gelistirici neyin insa edilecegini, neyin kapsam disinda oldugunu ve hangi kararlarin korunmasi gerektigini anlayabilir.
- Dokumantasyon, henuz yazilmamis kodlar varmis gibi izlenim vermez.

---

## Faz 1: Monorepo Temeli

**Hedef:** Kurulabilen, kontrol edilebilen ve tutarli calistirilabilen gelistirme temeli.

- [x] Root `package.json`, `pnpm-workspace.yaml`, `turbo.json`.
- [x] `apps/backend` (NestJS 12, health + Swagger + Pino + env dogrulama), `apps/web-customer` (Next.js 16 PWA, port 3000), `apps/web-admin` (Next.js 16, port 3002).
- [x] `packages/contracts` (kurus yardimcilari, durum enum'lari, health semasi), `packages/tsconfig`, `packages/eslint-config`.
- [x] TypeScript strict (6.0; 7.0 lint/test araclari destekleyene kadar bekliyor), ortak lint (ESLint 9) ve Prettier.
- [x] PostgreSQL, Redis, Mosquitto icin Docker Compose (`docker/docker-compose.dev.yml`, portlar yalniz 127.0.0.1).
- [x] Placeholder degerli `.env.example`, CI'da gitleaks secret taramasi.
- [x] CI temeli: format, lint, typecheck, test, build, compose dogrulama (`.github/workflows/ci.yml`).

**Tamamlanma Kriterleri**
- [x] `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` repo kokunden basarili calisir (2026-09-25).
- [x] Lokal altyapi Docker Compose ile ayaga kalkar (2026-09-25: Postgres, Redis, Mosquitto healthy; host portlari 15432/16379/11883/19001).
- [ ] CI GitHub'da ilk kez yesil calisir (dal henuz itilmedi).

---

## Faz 2: Cuzdan ve Ledger Cekirdegi

**Hedef:** Seans ve odeme mantigi uzerine kurulmadan once para dogrulugunu izole olarak kanitlamak. Bu faz IoT'ye ve gercek odeme saglayicisina bagli degildir.

- [x] Kullanici, cuzdan, ledger entry, bloke (`WalletHold`), istasyon, peron, yikama programi ve peron-program icin Prisma 7 semasi + ilk migration.
- [x] Negatif bakiye ve gecersiz hold durumlarini engelleyen DB CHECK constraint'leri (ADR-0004).
- [x] CREDIT / HOLD / CAPTURE / RELEASE cuzdan operasyonlari (`WalletService`, gercek PostgreSQL uzerinde entegrasyon testli).
- [~] Yikama programlari ve saniyelik kurus tarifesi: sema + seed hazir. Admin yonetim API'si Faz 6'da.
- [x] Kritik yazma islemleri icin idempotency (credit ve hold anahtarli; capture/release blokeye gore idempotent).
- [x] Ledger degismezligi: UPDATE/DELETE veritabani trigger'i ile reddedilir.

**Tamamlanma Kriterleri** (2026-09-25, 19 entegrasyon testi)
- [x] Eszamanli istekler bakiyeyi negatife dusuremez: 5000 bakiyeye 20 paralel 1000'lik bloke, tam 5'i basarili.
- [x] Her finansal hareket denetlenebilir ledger kaydi uretir; ledger'dan yeniden hesaplanan bakiye cuzdanla birebir ayni.
- [x] Ayni idempotency key ile tekrarlanan istek duplicate hareket olusturmaz: 10 paralel ayni webhook, tek yukleme.
- [x] Ayni blokeye 10 paralel tahsil: para yalnizca bir kez duser.

---

## Faz 3: Donanim Spike (Atilabilir Prototip)

**Hedef:** ESP32 + role + MQTT zincirinin **fiziksel olarak** calistigini, ag/guc sorunlarinda guvenli davrandigini erken gormek. Backend yalnizca minimal bir MQTT komut betigidir; bu fazin kodu ana backend'e tasinmaz.

> Etiket: **SPIKE.** Buradaki backend tarafi kodu Faz 4'te yeniden yazilir. Kalici cikti, firmware ve olculen davranistir.

- [ ] ESP32 firmware temeli: donanimsal MAC kimligi, MQTT over TLS, 4 kanalli role.
- [ ] Wi-Fi Captive Portal (AP modu) ile saha kurulumu.
- [ ] NVS'te seans kaydi; guc kesilip gelince kalan sureyle devam.
- [ ] Baglanti kaybinda lokal sayac ve role kapatma (fail-safe).
- [ ] Watchdog (WDT) ve yeniden baslatma davranisi.
- [ ] Olcum: komut-ACK gecikmesi, tekrar eden komut davranisi (ayni `commandId` ikinci kez gelirse role tekrar cekilmemeli).
- [ ] Dokunmatik TFT ekran: bostayken peron QR'i + kisa peron kodu, seans sirasinda yalnizca kalan sure ve kisa durum metni (`CALISIYOR`, `BITTI`, `HATA`). Dokunmatik giris MVP'de kullanilmaz. Geri sayim yerel sayactan gelir. QR ekranda gosterilir (basili etiket QR-jacking'e aciktir, bkz. `IOT.md`).
- [ ] Firmware'in kabul edecegi kontrat: `docs/IOT.md` payload'lariyla birebir uyumlu.

**Tamamlanma Kriterleri**
- Test betigiyle gonderilen START role'yi fiziksel olarak ceker, STOP birakir.
- Ag ve guc kesintisinde role beklenmedik sekilde acik kalmaz.
- Ayni komut iki kez gonderilince yan etki bir kez olusur.

**Not:** Gercek bir ESP32 (dokunmatik ekranli) elde mevcut, bu yuzden faz gercek cihazla yurutulur. Faz 4'te ek olarak mock cihaz simulatoru da kullanilir (CI'da donanimsiz test icin). Gercek role kartina baglanmadan once role bacaklarina kontrol LED'i/multimetre ile dogrulama yapilmasi onerilir; 220V yuk baglantisi ehliyetli kisi tarafindan yapilmalidir.

---

## Faz 4: Seans ve IoT Entegrasyonu

**Hedef:** Faz 2 (para) ve Faz 3 (donanim) sonuclarini, dayanikli bir seans akisinda birlestirmek.

> Durum (2026-09-25): cekirdek tamam (`feat/faz-4-session`), gercek cihazla uctan uca denendi (`pnpm --filter @qwash/backend demo:session`). Kararlar: [ADR-0010](adr/0010-session-flow-implementation.md).

- [x] NestJS backend: health endpoint, structured logging (Pino). _(Faz 1'de)_
- [x] Deterministik seans state machine (ADR-0007, ADR-0010): `STARTING → RUNNING → COMPLETED`, hata: `FAILED`, belirsizlik: `RECONCILING`. Her gecis `SessionTransition`'a yazilir.
- [x] Two-phase ACK: HOLD → MQTT START → STARTED_ACK → RUNNING; tahsilat seans sonunda kullanilan sure kadar (ADR-0010). ACK gelmezse RELEASE (10 sn) + tedbiren STOP.
- [x] **Gec ACK kurali:** RELEASE edilmis/iptal edilmis bir seans icin sonradan `STARTED_ACK` gelirse backend derhal STOP gonderir ve olayi kaydeder. Gerekce: saati senkron olmayan cihaz `expiresAt` kontrolunu yapamaz ve suresi dolmus START'i kabul eder (Faz 3'te cihazda goruldu, 2026-09-25).
- [x] Komutlar icin transactional outbox, ACK/olaylar icin idempotent inbox (ADR-0005; BullMQ yerine DB yoklamasi, ADR-0010).
- [x] **Seans sonu mutabakati:** Cihazin bildirdigi kalan sureden kullanilan sure hesaplanir; o kadar tahsil, kalani iade. Bitis bildirilmezse `RECONCILING` (bloke durur), cihaz donup bitisi bildirince kapanir. Iade edilmis seansta cihaz calistigini bildirirse `UNPAID_RUN_REPORTED` olarak isaretlenir.
- [x] **RECONCILING'de kalan seans icin is kurali (2026-09-25):** 30 dk cihaz beklenir; donmezse yalnizca kanitlanmis kullanim tahsil, kalan iade, admin incelemesine isaret (ADR-0010 #8). Firmware son bitisi her baglantida yeniden gonderir.
- [x] Device twin: desired/reported state, drift tespiti (ADR-0006). Desired seans tablosundan turetilir; heartbeat ile karsilastirilir. Aktif seansi olmayan calismaya aninda STOP (`DRIFT`), diger uyusmazliklar 15 sn tolerans sonrasi `Device.driftConfirmedAt`. Admin bildirimi Faz 6.
- [ ] MQTT guvenligi: TLS, cihaz basina kimlik/ACL (cihaz yalniz kendi topic'lerine yazar/okur).
- [ ] Gercek zamanli seans durumu (Socket.IO) + `GET /sessions/active` ile durum geri yukleme.

**Tamamlanma Kriterleri**
- START'a ACK gelmezse bloke tutar serbest kalir, peron `ERROR` olur.
- Seans sirasinda ag kopsa da cihaz lokal olarak kapanir ve sunucu mutabakat ile toparlar.
- Tekrarlanan MQTT mesajlari duplicate yan etki uretmez.
- Bir cihaz baska peronun topic'ine yazamaz (ACL testi).
- Ariza enjeksiyon testleri (mesaj kaybi, gec ACK, cift ACK, broker restart) gecer.

---

## Faz 5: Odeme (Iyzico) ve Musteri PWA

**Hedef:** Gercek musteri akisini uctan uca acmak: QR → giris → bakiye yukle → seans baslat → izle.

- [x] Iyzico Checkout Form entegrasyonu (Faz 5b backend): REST istemcisi (IYZWSv2, yanit imzasi), `CardTopUp`, admin ayarli minimum + kat hazir tutarlar (`TopUpSettings`). Kart verisi sunucuya hic gelmez.
- [ ] Iyzico sandbox'ta gercek 3D Secure denemesi (Burak'in sandbox anahtarlari gerekli); zorunlu alici alanlari (TCKN yer tutucu, adres, telefon) sandbox'ta dogrulanir.
- [x] Webhook V3 imza dogrulamasi, idempotent isleme, dakikalik mutabakat worker'i (gec basari EXPIRED'dan da islenir).
- [x] Basarisiz/tekrarlanan/eszamanli callback'in duplicate bakiye olusturmadigi testi (21 servis + 4 HTTP + 7 imza birim testi).
- [ ] Webhook icin herkese acik adres (sandbox'ta tunel, canlida alan adi) ve Iyzico panelinde bildirim URL'si.
- [x] Kimlik dogrulama backend'i (ADR-0009, Faz 5a): e-posta/sifre + e-posta dogrulama, Google girisi, sifre sifirlama, refresh rotasyonu + reuse tespiti, rate limit, API yanit zarfi. 30 test (servis + HTTP).
- [ ] Google OAuth client/consent ekrani (Google Cloud Console; Burak) ve `GOOGLE_CLIENT_ID`.
- [ ] E-posta saglayicisi secimi ve `Mailer` uygulamasi (production icin zorunlu).
- [ ] Iyzico zorunlu alici alanlari sandbox'ta dogrulanir; telefon gerekirse profilden istenir.
- [ ] KVKK: aydinlatma metni, kullanim sartlari (iade politikasi metni dahil), hesap silme akisi.
- [ ] QR sonrasi peron onay adimi ("Peron X'e baglaniyorsunuz"); QR adresi yalniz QWASH alan adina gider, bilinmeyen `bayCode` icin anlasilir hata.
- [ ] Musteri PWA (Next.js): QR ile peron baglama, kayit/giris, bakiye yukleme, program secimi, canli seans ekrani (kalan sure/bakiye).
- [ ] PWA manifest, ana ekrana ekleme, arka plandan donuste seans durumu geri yukleme (ADR-0008).
- [ ] Kullanici deneyimi: ilk kez gelen musteri icin sade akis, hata durumlarinda anlasilir mesaj (ACK zaman asimi, yetersiz bakiye, peron dolu).
- [ ] Web Push: opsiyonel, yalnizca pilot ihtiyaci dogarsa.

**Tamamlanma Kriterleri**
- Sandbox'ta kart ile bakiye yuklenir, seans baslatilir, cihaz fiziksel calisir, kalan bakiye dogru dusulur.
- Cift webhook / gec webhook / iptal edilen odeme bakiyeyi bozmaz.
- Mobil tarayicida (iOS Safari, Android Chrome) akis sorunsuz tamamlanir.

---

## Faz 6: Admin Operasyonlari

**Hedef:** Operatore sistemi calistirmak ve desteklemek icin gereken araclari vermek.

- [ ] Canli peron durumu dashboard'u.
- [ ] Bakim modu ve acil durdurma.
- [ ] Kullanici ve cuzdan arama.
- [ ] Kasada nakit yukleme: operator musteriyi bulur (e-posta), tutari girer, makbuz numarasi uretilir, idempotent yazilir. Gun sonu kasa raporu (istasyon/gun/operator toplami). (Karar: Burak, 2026-09-25)
- [ ] Zorunlu gerekce ve audit kaydi ile manuel bakiye duzeltme (yalniz hata duzeltme, nakit yukleme icin kullanilmaz).
- [ ] Program/tarife yonetimi (ekleme, fiyat degistirme, soft-delete, role esleme).
- [ ] Cihaz sagligi: heartbeat, RSSI, alarm gorunurlugu.
- [ ] Admin girisi guclendirme: rol tabanli yetki, oturum suresi, gerekirse MFA.

**Tamamlanma Kriterleri**
- Operator peron ve cihaz durumunu tek ekrandan gorur.
- Tum bakim ve finansal aksiyonlar denetlenebilir kayit uretir.

---

## Faz 7: Pilot Guclendirme

**Hedef:** Sistemi sinirli bir gercek saha pilotuna hazirlamak.

- [ ] Production Docker/Nginx deployment.
- [ ] Yedekleme ve **test edilmis** restore proseduru.
- [ ] Gozlemlenebilirlik: log toplama, health check, temel alarm (cihaz cevrimdisi, odeme hatasi, ACK zaman asimi orani).
- [ ] Eszamanli seans baslatma icin yuk testi.
- [ ] Musteri, admin, API ve cihaz akislari icin smoke testler.
- [ ] Guvenlik gozden gecirmesi: auth, secret yonetimi, MQTT, odeme, rate limit.
- [ ] Yaygin arizalar icin operasyon runbook'u.
- [ ] Saha kurulum ve devreye alma kontrol listesi.
- [ ] Faz 3'teki donanim spike'inin gercek cihazla dogrulandiginin kaydi.

**Tamamlanma Kriterleri**
- Pilot istasyon deploy edilebilir, izlenebilir, restart sonrasi toparlanabilir.
- Restore gercekten denenmis ve dokumante edilmis.
- Yuk ve ariza testlerinde double spending veya kayip odemeli seans olusmaz.

---

## Acik Sorular (Faz 0'da Kapatilmali)

| # | Soru | Durum |
|---|---|---|
| 1 | Tarife gercek mi ornek mi? | **Kapandi (2026-09-25):** Fiyatlari admin belirler; dokumandaki degerler seed/ornek. |
| 2 | Musteri kimligi | **Kapandi (2026-09-25):** E-posta/sifre + Google, misafir yok, telefon opsiyonel (ADR-0009). |
| 3 | Ekran davranisi | **Kapandi (2026-09-25):** Dokunmatik ekran yalnizca sure gosterir; girisler PWA'dan. |
| 4 | Iade / para cikarma politikasi | **Kapandi (2026-09-26, Burak):** Bakiye iadesi yok. Iki istisna: (a) teknik hata / hizmet alamama (su, elektrik, vana, sistem arizasi) icin musteri destek talebi acar; (b) hesap silme / kullanimdan vazgecme durumunda kalan bakiye talep edilebilir. Iade yalniz paranin yuklendigi orijinal kart islemine Iyzico refund/cancel ile yapilir. Iade kullanici arayuzunden tek tikla yapilmaz: destek kanaliyla gelir, admin panelinden (Faz 6) yonetici onayiyla yapilir. **Ek (2026-09-26, Burak):** (1) Iade edilebilirlik FIFO: harcama en eski yuklemeden dusulmus sayilir, kalan bakiye en yeni yuklemelere aittir. (2) Iyzico iadesi odemeden sonra en fazla 365 gun mumkun; bu sureyi asan kisim yalniz musterinin kendi adina kayitli IBAN'a EFT ile (ad-soyad uyusmasi sart, aciklama `QWASH-REFUND-<USER_ID>`), admin onayiyla. (3) Hesap silmede uc secenek: bakiyeyi kullan (silme iptal), bakiyeden feragat (onay kutusu, ledger'a feragat kaydi, bakiye sifir), iade talebi. (4) 9-10 aydir hareketsiz bakiyeli hesaplara hatirlatma. |
| 5 | Minimum bakiye yukleme tutari | **Kapandi (2026-09-26, Burak):** Admin ayarlar. Musteri ekranindaki hazir tutarlar bu minimumun katlarindan otomatik uretilir (orn. 50 → 50 / 100 / 200). |
| 6 | Elektrik/internet kesintisinde iade politikasi | **Kapandi (4a ile):** Cihaz kaybinda kanitlanmis sure disi otomatik iade (Faz 4); diger ariza iadeleri destek talebi + admin onayi. |
| 7 | Bir istasyonda kac peron, bir peronda kac program/role? | **Kismen:** Cihaz basina 4 role (Su/Kopuk/Cila/Hava). Istasyon basina peron sayisi acik; MVP tek peron. |
| 8 | E-fatura/e-arsiv gerekiyor mu? | **Acik.** Muhasebeciyle teyit edilmeli; odeme akisina ek entegrasyon gerektirebilir. |
| 9 | Pilotun yeri, kapsami ve zamani | **Acik.** Faz 7 oncesi belirlenecek. |

---

## Sonraki Adaylar (MVP Disi)

- Native iOS/Android uygulamasi (karar olcutleri ADR-0008'de).
- Firmware OTA ve rollback.
- Hassas admin islemleri icin step-up MFA (Faz 6'da temel MFA yapilmadiysa).
- Hash-chain audit loglari.
- Cok istasyonlu kurumsal raporlama.
- Sadakat / kampanya / abonelik.
- Coklu ulke ve para birimi.
