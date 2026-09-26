# ADR-0011: Admin Operasyonlari (Faz 6)

- **Durum:** Kabul Edildi
- **Tarih:** 2026-09-26
- **Iliskili:** [ADR-0004](0004-ledger-and-money-in-kurus.md), [ADR-0009](0009-customer-authentication.md), [ADR-0010](0010-session-flow-implementation.md), `SECURITY.md` 1.3

---

## Baglam

Faz 6 operatore sistemi calistirma araclari verir: nakit yukleme, iade isleme, bakiye duzeltme, peron/cihaz izleme, bakim modu, program/tarife yonetimi. Bu islemlerin cogu **para hareket ettirir** veya **suyu acip kapatir**; bu yuzden yetki, denetim izi ve idempotency musteri tarafindan daha siki olmalidir. Operasyonu simdilik tek kisi (Burak) yurutuyor, ama kurallar birden fazla operatore gore kurulur.

## Kararlar

### 1. Ayni kimlik sistemi, ayri yetki kontrolu

Admin, musteriyle ayni `User` tablosunu ve `/auth/login` akisini kullanir (`role` = `ADMIN` / `SUPER_ADMIN`). Ayri bir admin kimlik sistemi kurulmaz: sifre saklama, refresh rotasyonu ve reuse tespiti zaten test edilmis durumda.

`AdminGuard`, access token'daki `role` claim'ine **guvenmez**; her istekte veritabanindan `role` ve `status` okur. Gerekce: access token 15 dk gecerli; yetkisi alinan ya da askiya alinan bir admin bu sure boyunca para hareket ettirememeli. Admin istek hacmi dusuk oldugu icin tek sorgunun maliyeti onemsiz.

Rol ayrimi:

| Islem | ADMIN | SUPER_ADMIN |
|---|---|---|
| Okuma (kullanici, cuzdan, peron, cihaz, seans, rapor) | evet | evet |
| Nakit yukleme, iade isleme, bakim modu, seansi durdurma | evet | evet |
| Manuel bakiye duzeltme (gerekce zorunlu) | hayir | evet |
| Yukleme ayarlari, program/tarife, admin rolu verme | hayir | evet |

Bakiye duzeltme SUPER_ADMIN'e ayrildi: kaynagi olmayan para yaratabilen tek islem budur (nakit yuklemede kasadaki nakit, iadede Iyzico/EFT kaydi karsiligi vardir).

Ilk SUPER_ADMIN bir komut satiri betigiyle atanir (`pnpm admin:grant <e-posta> SUPER_ADMIN`); API uzerinden kimse kendini yukseltemez.

MFA bu fazda yapilmaz (tek operator, yerel pilot). Canliya cikmadan once hassas islemler icin step-up MFA Faz 7'de degerlendirilir (ROADMAP "Guvenlik" bolumu).

### 2. Degistirilemez denetim kaydi

`AdminAuditLog`: kim (`actorId`), ne (`action`), neye (`targetType`, `targetId`), neden (`reason`), ayrinti (`details` JSON), ne zaman. Ledger gibi UPDATE/DELETE veritabani trigger'i ile reddedilir.

Para hareketi yapan her admin islemi, **ledger kaydiyla ayni transaction'da** denetim kaydi yazar. Ya ikisi birlikte olur ya hicbiri; "para hareket etti ama kim yaptigi bilinmiyor" durumu olusamaz.

### 3. Nakit yukleme

Operator musteriyi e-postayla bulur, tutari girer. Sunucu:

- `CashTopUp` kaydi + `CASH_TOPUP` CREDIT + denetim kaydi tek transaction'da,
- artan makbuz numarasi (`receiptNo`, veritabani dizisi; bosluk olabilir, tekrar olamaz),
- istemcinin urettigi `Idempotency-Key` (`cash-topup:<key>`); ayni anahtar tekrar gelirse ayni makbuz doner, ikinci para girisi olmaz (cift tiklama, ag tekrari),
- yalniz `ACTIVE` hesaba; e-posta dogrulamasi aranmaz (operator musteriyi yuz yuze goruyor),
- ust sinir `TopUpSettings.maxTopUpKurus` (kart ile ayni).

Gun sonu kasa raporu istasyon + gun + operator bazinda nakit girisini (`CASH_TOPUP`) ve kasadan cikan nakit iadeyi (`CASH_REFUND`) toplar; beklenen kasa = giris − cikis.

### 4. Manuel bakiye duzeltme

Yalniz hata duzeltmek icindir, nakit yukleme icin kullanilmaz. `ADJUSTMENT` kaynakli CREDIT veya DEBIT; gerekce en az 10 karakter, idempotency anahtari zorunlu. DEBIT bloke edilmis tutara dokunamaz (musterinin aktif seansi bozulmaz).

### 5. Iade talebinin islenmesi

`RefundRequest.allocation` (FIFO dagilimi) her parca icin bir `RefundPayout` satirina donusur. Parca yontemleri:

- **CARD:** Iyzico `/payment/refund`, ilgili `CardTopUp.paymentTransactionId` ile kismi iade.
- **IBAN:** EFT'yi admin bankadan elle yapar; alici adini muhurlu adla (`holderName`) gozle karsilastirir, dekont numarasini girer.
- **CASH_AT_STATION:** Admin kasadan oder; `CASH_REFUND` olarak kasa raporuna girer.

**Cift iade riski ve cozumu:** Iyzico iade cagrisi basarili olup cevap bize ulasmadan surec coker ya da ag koparsa, "tekrar dene" ikinci iade demektir. Bu yuzden CARD parcasi Iyzico'ya gitmeden once ayri bir transaction'da `IN_FLIGHT` isaretlenir. Cevap gelirse `DONE` / `FAILED`. `IN_FLIGHT`'ta kalmis bir parca **otomatik yeniden denenmez**; admin Iyzico panelinden kontrol edip "yapildi" (Iyzico referansiyla) veya "yapilmadi, yeniden dene" der. Para kaybi yonunde otomatik davranis yoktur.

Tum parcalar `DONE` olunca, tek transaction'da: iade blokesi tamamen tahsil edilir (`REFUND` CAPTURE, para cuzdandan cikar), CARD parcalari icin `CardTopUp.refundedKurus` artar, talep `COMPLETED` olur, `contactEmail` temizlenir (KVKK: amac gerceklesti), denetim kaydi yazilir.

Talep reddedilirse (gerekce zorunlu) bloke serbest birakilir; yalniz hic parca odenmemisse mumkundur.

### 6. Bakim modu ve acil durdurma

Bakim modu peronu `MAINTENANCE` yapar; yeni seans baslatilamaz. Suren seans kesilmez (musteri parasini odedigi sureyi kullanir); seans bitince peron `IDLE`'a degil `MAINTENANCE`'ta kalir. Acil durdurma ayri bir islemdir: admin seansi durdurur, cihaza STOP gider (musterinin durdurmasiyla ayni yol, neden `ADMIN_STOP`), tahsilat kullanilan saniye kadardir.

### 7. Admin paneli ayri uygulama

`apps/web-admin` (port 3002) musteri PWA'sindan ayri kalir: farkli guvenlik basliklari, PWA/servis worker yok, arama motoruna kapali. Backend CORS listesine admin kokeni eklenir.

## Sonuclar

- Para hareket ettiren her admin islemi ledger + denetim kaydi ciftiyle izlenebilir.
- Iade islemede otomatik yeniden deneme yoktur; belirsiz durumda insan karar verir. Bu, operatore biraz is yukler ama cift iadeyi imkansiz kilar.
- Rol degisikligi aninda etkili olur (DB kontrolu).
- MFA yok; canlidan once tekrar ele alinmali.
