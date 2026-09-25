# ADR-0010: Seans Akisinin Uygulama Kararlari (Faz 4)

- **Durum:** Kabul Edildi
- **Tarih:** 2026-09-25
- **Iliskili:** [ADR-0005](0005-outbox-inbox-pattern.md), [ADR-0007](0007-session-state-machine-and-two-phase-ack.md), [ADR-0002](0002-bullmq-over-kafka.md)

---

## Baglam

ADR-0005 ve ADR-0007 seans akisinin ilkelerini koyar. Faz 4'te bu ilkeler koda donusurken bazi noktalar netlestirildi veya degistirildi. Faz 3'te gercek cihazla yapilan testler de (saatsiz cihazin suresi dolmus komutu kabul etmesi, guc kesintisinde surenin uzamasi) kararlari etkiledi.

## Kararlar

### 1. Durumlar ve tek transaction

`CREATED → RESERVED → FUNDS_HELD → START_COMMAND_SENT` ara durumlari yerine **HOLD + seans kaydi + START komutu tek transaction'da** yazilir. Ara durumlar yalnizca "yarim kalmis" kayit uretme riskini temsil ediyordu; tek transaction bu riski ortadan kaldirir.

```
STARTING ──STARTED_ACK SUCCESS──▶ RUNNING ──SESSION_ENDED──▶ COMPLETED
   │                                 │
   ├─ REJECTED ────────▶ FAILED      └─ sure + 30 sn, bitis yok ─▶ RECONCILING ──SESSION_ENDED──▶ COMPLETED
   └─ 10 sn ACK yok ────▶ FAILED (+ tedbiren STOP)
```

Her gecis `SessionTransition` tablosuna neden ve ayrintiyla yazilir (denetim izi).

### 2. Tahsilat seans sonunda

ADR-0007 "STARTED_ACK → CAPTURED" diyordu. Uygulamada **STARTED_ACK yalnizca RUNNING'e gecirir; tahsilat, cihaz bitisi bildirince kullanilan saniye kadar yapilir**, kalan bloke iade edilir (`WalletService.capture` kismi tahsil + iade).

Gerekce: musteri erken durdurunca kullanmadigi sureyi odememeli. Bloke seans boyunca durdugu icin cift harcama riski yoktur.

Kullanilan sure = planlanan sure − cihazin bildirdigi kalan sure (0 ile planlanan arasinda sinirlanir).

### 3. BullMQ yerine veritabani yoklamasi

ADR-0005 outbox yayincisini BullMQ worker olarak tarif ediyordu. Uygulamada iki basit dongu kullanilir (`SessionWorker`):

- **Outbox yayini** (250 ms): `PENDING` kayitlar `FOR UPDATE SKIP LOCKED` ile alinir, yayinlanir, `PUBLISHED` isaretlenir.
- **Seans taramasi** (1 sn): ACK suresi dolan `STARTING` seanslar `FAILED`, bitisi bildirilmeyen `RUNNING` seanslar `RECONCILING` olur.

Gerekce: tum durum (bekleyen komut, ACK son tarihi) zaten veritabaninda. Yeniden baslayan surec hicbir sey kaybetmez; Redis'teki gecikmeli bir isin kaybolma veya iki kez calisma riski yoktur. `SKIP LOCKED` sayesinde birden fazla backend ornegi ayni anda guvenle calisir (gercek cihaz testinde iki ornek ayni anda calisti, ACK bir kez islendi). BullMQ, Faz 5'teki odeme mutabakati gibi gercek zamanlanmis isler icin gecerliligini korur.

### 4. Suresi dolmus komut yayinlanmaz

START komutu `expiresAt` (= ACK son tarihi) tasir. Outbox yayincisi suresi dolmus komutu **yayinlamaz** (`EXPIRED`). Cihaz saatsizken `expiresAt`'i kontrol edemedigi icin (Faz 3 bulgusu) bu kontrol sunucu tarafinda da yapilir.

### 5. Gec ACK ve tedbir STOP'u

- ACK zaman asiminda bloke iade edilir ve **tedbiren STOP gonderilir** (cihaz START'i almis, ACK'i kaybolmus olabilir).
- Iade edilmis seansa `STARTED_ACK` gelirse **STOP gonderilir** (gec ACK kurali).
- Iade edilmis seansta cihaz calistigini bildirirse para hareket etmez, `UNPAID_RUN_REPORTED` olarak isaretlenir (admin raporu icin).
- Firmware STOP'u **yalnizca komuttaki `sessionId` aktif seansla eslesirse** uygular. Aksi halde gec ulasan tedbir STOP'u ayni perondaki yeni musterinin seansini kesebilirdi.

### 6. Tekrar ve yaris korumalari

- Peron basina tek aktif seans: kismi unique index (`status IN (STARTING, RUNNING, RECONCILING)`).
- Istemci istegi idempotency anahtari tasir; ayni anahtar ikinci seans/bloke acmaz.
- Cihaz olaylari `eventId` ile `InboxMessage`'a yazilir (`ON CONFLICT DO NOTHING`), olay isleme ile ayni transaction'da.
- Her durum degisikligi seans satiri `FOR UPDATE` kilitliyken yapilir; ACK isleyicisi ile zaman asimi taramasi ayni seansi ayni anda degistiremez.
- Topic'teki peron seansin peronuyla eslesmezse mesaj yok sayilir (ACL'ye ek uygulama katmani kontrolu). Bir perona bagli cihaz varken baska bir cihaz o perona baglanamaz.

### 7. Peron uygunlugu

Yeni seans icin cihazin son bildirdigi durum `ONLINE` olmali ve son 90 sn icinde haber vermis olmali (heartbeat 30 sn). `Bay.status` bilgi amaclidir; yalnizca `MAINTENANCE` yeni seansi engeller. `ERROR` engellemez, cunku cihaz saglikliyken takili kalmis bir `ERROR` peronu kalici olarak kapatirdi.

### 8. Cihazi kaybolan seans (is kurali, 2026-09-25)

Proje sahibinin onayladigi kural:

1. Bitis bildirilmeyen seans `RECONCILING`'e gecer, bloke durur, **30 dakika** cihaz beklenir. Cihaz donup bitisi bildirirse seans gercek sureyle kapanir.
2. Donmezse **yalnizca kanitlanmis kullanim** tahsil edilir, kalani iade edilir, seans `needsReview` ile admin incelemesine isaretlenir, peron `ERROR` olur.
3. **Kanitlanmis kullanim:** cihazin seans sirasinda heartbeat (seansta 10 sn'de bir) ve `SESSION_RECOVERED` ile bildirdigi kalan sureden hesaplanir. Deger yalnizca artar; yalnizca perona bagli cihazin mesaji sayilir.
4. Otomatik kapatmadan sonra cihaz donerse gercek sure `LATE_END_AFTER_AUTO_CLOSE` olarak kaydedilir; para hareket etmez (tahsil edilen sure kesin bir alt sinirdi, fark admin kararina kalir).

Reddedilen secenekler: tam tahsil (elektrik kesintisinde role kapanir, musteri fazla oder), tam iade (fisi cekerek bedava yikama), yalnizca admin karari (para gunlerce askida kalir).

Firmware tarafi: son biten seans NVS'te tutulur ve **her MQTT baglantisinda yeniden gonderilir** (PubSubClient QoS 0 yayinlar; cevrimdisiyken biten seansin bildirimi aksi halde kaybolurdu). Backend tekrarlari yok sayar; inceleme isaretleri bir kez yazilir.

### 9. STOP takibi ve durdurma tavani (is kurali, 2026-09-26)

Sorun: musteri durdurdugunda STOP cihaza ulasmazsa (cihaz o an kopuk; cihaz clean session ile baglandigi icin broker saklamaz) cihaz tam sure calisiyor ve musteriden tam sure tahsil ediliyordu. Burak iki onlemi de onayladi:

1. **Tahsilat tavani:** Musteri durdurdugunda tahsil edilebilecek en uzun sure = durdurma ani - baslama (`startedAt`) + `stopGraceSec` (5 sn). ACK'ten once durdurulduysa yalnizca pay. Cihaz daha uzun calistigini bildirirse fazlasi tahsil edilmez, seans `needsReview` ile isaretlenir ve gecis kaydina `reportedUsedSeconds` yazilir. Tavan cihaz bitisinde de otomatik kapatmada da (kanitlanmis kullanim) uygulanir. Sistem hatasinin maliyeti isletmede kalir.
2. **STOP yeniden gonderimi:** STOP (musteri, ACK zaman asimi, gec ACK) cihazdan herhangi bir `STOPPED_ACK` (`NOT_ACTIVE` dahil) ya da seans bitisi gelene kadar `stopRetryMs` (5 sn) arayla, en fazla `stopMaxAttempts` (24, ~2 dk) kez gonderilir. Her gonderim yeni `commandId` tasir; firmware STOP'u yalnizca `sessionId` eslesirse uyguladigi icin ayni perondaki yeni seansi kesmez. Onceki STOP outbox'ta bekliyorsa (broker yok) yenisi eklenmez. Baska perondan gelen onay sayilmaz.

Alanlar: `stopRequestedAt` (ilk durdurma ani), `stopReason`, `lastStopSentAt`, `stopAttempts`, `stopConfirmedAt`.

## Acik kalanlar

- MQTT TLS ve cihaz basina ACL (su an yalniz gelistirme broker'i, anonim).
- Admin paneli: `needsReview` seanslarin listesi ve elle ek iade (Faz 6).
