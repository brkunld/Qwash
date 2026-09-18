# QWASH — Muhendislik Roadmap'i

Bu roadmap, projenin once calisan bir urun cekirdegine ulasmasini, daha sonra production seviyesinde guclendirilmesini hedefler. Ana prensip basittir: Her faz yalnizca dokuman degil, dogrulanabilir bir teslimat uretmelidir.

> Mevcut durum: Proje su anda dokumantasyon ve mimari planlama asamasindadir. Uygulama kodu, monorepo konfigürasyonu ve altyapi dosyalari henuz repoda mevcut degildir.

---

## Teslimat Prensipleri

| Prensip                      | Anlami                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| Once MVP, sonra olcek        | Cok istasyonlu yapiya gecmeden once tek peron akisi calismalidir.                               |
| Para guvenligi cekirdektir   | Cuzdan, ledger, idempotency ve veritabani kurallari sonradan eklenecek detaylar degildir.       |
| Donanim gercegi onceliklidir | ESP32 davranisi yalnizca mock API ile degil, gercek cihaz geri bildirimiyle test edilmelidir.   |
| Karmasiklik fazlandirilir    | OTA, chaos testing ve MFA gibi enterprise ozellikler MVP akisi kanitlandiktan sonra ele alinir. |

---

## Faz 0: Dokumantasyon ve Mimari Temel

**Hedef:** Kodlamaya baslamadan once kapsam, non-goals, mimari ve uygulama sinirlarini netlestirmek.

- [ ] Urun vizyonu ve kapsam dokumante edildi.
- [ ] Temel mimari kararlar ADR olarak yazildi.
- [ ] IoT, API, veritabani, guvenlik ve test yonu dokumante edildi.
- [ ] Dokumantasyon linkleri kontrol edildi.
- [ ] Mevcut uygulama durumu ile planlanan mimari ayrildi.

**Tamamlanma Kriterleri**

- Yeni bir gelistirici neyin insa edilecegini, neyin bilerek kapsam disinda tutuldugunu ve hangi muhendislik kararlarinin korunmasi gerektigini anlayabilir.
- Dokumantasyon, henuz uygulanmamis kodlar varmis gibi izlenim vermez.

---

## Faz 1: Monorepo Temeli

**Hedef:** Kurulabilen, kontrol edilebilen ve tutarli sekilde calistirilabilen bir gelistirme temeli olusturmak.

- [ ] Root `package.json`, `pnpm-workspace.yaml` ve `turbo.json`.
- [ ] `apps/backend`, `apps/web-customer`, `apps/web-admin`.
- [ ] `packages/contracts`, `packages/tsconfig`, `packages/eslint-config`.
- [ ] TypeScript strict mode, ortak lint ve formatlama.
- [ ] PostgreSQL, Redis ve Mosquitto icin Docker Compose.
- [ ] Guvenli placeholder degerler iceren `.env.example`.
- [ ] Lint, typecheck ve build icin CI temeli.

**Tamamlanma Kriterleri**

- `pnpm install` basariyla tamamlanir.
- `pnpm typecheck` ve `pnpm lint` repo kokunden calistirilabilir.
- Lokal altyapi Docker Compose ile baslatilabilir.

---

## Faz 2: MVP Dikey Dilim

**Hedef:** Tek peron, tek test kullanicisi ve tek ESP32 cihaz ile uctan uca yikama akisini kanitlamak.

- [ ] Health endpoint ve structured logging iceren NestJS backend iskeleti.
- [ ] Seans baslatma ve durdurma icin basit musteri web ekrani.
- [ ] MQTT komut gonderimi ve ACK dinleme.
- [ ] ESP32 donanimsal MAC kimligi, Wi-Fi Captive Portal (AP modu), MQTT ve 4 kanalli role kontrolu icin firmware temeli.
- [ ] Start, running, stop ve timeout icin temel session state akisi.
- [ ] Socket.IO veya benzeri anlik seans durumu.

**Tamamlanma Kriterleri**

- Kullanici tarayicidan test seansi baslatabilir.
- Start komutundan sonra ESP32 rolesi fiziksel olarak aktif olur.
- Seans durdurulabilir ve role kapanir.
- Timeout davranisi sistemi tahmin edilebilir bir durumda birakir.

---

## Faz 3: Cuzdan, Ledger ve Odeme

**Hedef:** Gercek odemeli kullanima gecmeden once finansal dogrulugu saglamak.

- [ ] Kullanici, cuzdan, ledger entry, peron, yikama programlari ve seans icin PostgreSQL/Prisma semasi.
- [ ] Yikama programlari (Su, Kopuk, Cila, Hava) ve saniyelik kurus tarifesi yonetimi.
- [ ] Saniyelik kullanim bazli (sure x birim kurus) Hold, capture ve release cuzdan operasyonlari.
- [ ] Negatif bakiye ve gecersiz bloke durumlarini engelleyen veritabani constraintleri.
- [ ] Kritik yazma islemleri icin idempotency.
- [ ] Iyzico sandbox checkout entegrasyonu.
- [ ] Webhook dogrulama ve reconciliation worker.

**Tamamlanma Kriterleri**

- Eszamanli istekler cuzdan bakiyesini negatife dusuremez.
- Her finansal hareket denetlenebilir bir ledger kaydi uretir.
- Basarisiz veya tekrarlanan odeme callbackleri duplicate bakiye olusturmaz.

---

## Faz 4: IoT Dayanikliligi ve Device Twin

**Hedef:** Saha davranisini ag problemlerine ve tekrar eden mesajlara karsi dayanikli hale getirmek.

- [ ] Cihazlara giden komutlar icin transactional outbox.
- [ ] ACK ve telemetri mesajlari icin idempotent inbox.
- [ ] Session start ve payment capture icin two-phase ACK akisi.
- [ ] ESP32 lokal sayac ve fail-safe kapanis.
- [ ] Device twin desired/reported state karsilastirmasi.
- [ ] Drift ve cihaz sagligi alarmlari.

**Tamamlanma Kriterleri**

- ESP32 start onayi vermezse bloke edilen tutar serbest birakilir.
- Ag calisan seans sirasinda kopsa bile cihaz lokal olarak kapanir.
- Tekrarlanan MQTT mesajlari duplicate yan etki uretmez.

---

## Faz 5: Admin Operasyonlari

**Hedef:** Istasyon operatorlerine sistemi calistirmak ve desteklemek icin gerekli araclari vermek.

- [ ] Canli peron durumunu gosteren admin dashboard.
- [ ] Bakim modu ve acil durdurma.
- [ ] Kullanici ve cuzdan arama.
- [ ] Zorunlu audit nedeniyle manuel bakiye duzeltme.
- [ ] Fiyatlandirma konfigürasyonu.
- [ ] Cihaz sagligi, heartbeat ve alarm gorunurlugu.

**Tamamlanma Kriterleri**

- Operator peron durumunu ve cihaz sagligini tek ekrandan gorebilir.
- Bakim aksiyonlari denetlenebilir kayit uretir.
- Manuel finansal degisiklikler gerekce ister ve ledger/audit kaydi olusturur.

---

## Faz 6: Pilot Guclendirme

**Hedef:** Sistemi sinirli bir gercek saha pilotuna hazirlamak.

- [ ] Production Docker/Nginx deployment plani uygulanmis olur.
- [ ] Backup ve restore proseduru test edilir.
- [ ] Auth, secrets, MQTT ve odeme akisi icin guvenlik kontrolu yapilir.
- [ ] Eszamanli seans baslatma icin yuk testi yapilir.
- [ ] Musteri, admin, API ve cihaz akislari icin smoke testler hazirlanir.
- [ ] Yaygin arizalar icin operasyon runbook'u olusturulur.

**Tamamlanma Kriterleri**

- Pilot istasyon deploy edilebilir, izlenebilir ve restart sonrasi toparlanabilir.
- Backup restore yalnizca dokumante edilmez, test edilir.
- Yuk ve ariza testlerinde double spending veya kayip odemeli seans olusmaz.

---

## Sonraki Adaylar

Bu ozellikler MVP disinda tutulur; saha kullanimi ihtiyac dogurursa degerlendirilir:

- Native iOS ve Android uygulamalari.
- Coklu ulke ve coklu para birimi.
- Firmware OTA ve rollback.
- Hassas admin islemleri icin step-up MFA.
- Hash-chain audit loglari.
- Cok istasyonlu enterprise raporlama.
- Gelismis dinamik fiyatlandirma veya makine ogrenimi.
