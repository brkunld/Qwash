# Yük Testi: Eşzamanlı Seans Başlatma (Faz 7)

**Tarih:** 2026-09-26 · **Kod:** `apps/backend/test/load/session-load.load-spec.ts` · **Çalıştırma:** `pnpm --filter @qwash/backend test:load`

Faz 7 tamamlanma kriteri: *"Yük ve arıza testlerinde double spending veya kayıp ödemeli seans oluşmaz."*

## Yöntem

- Gerçek PostgreSQL (`qwash_test`), gerçek servis katmanı (`SessionService`, `WalletService`, outbox) ve bağlantı havuzu. Cihazlar MQTT mesajlarıyla taklit edilir; geliştirme veritabanına ve gerçek cihaza dokunulmaz.
- HTTP katmanı dahil değil: hız sınırı (kullanıcı başına 30 sn'de 3 başlatma) gerçek hayatta tek kullanıcının yükünü zaten keser. Test, para kurallarının sınırın arkasında da tuttuğunu gösterir.
- Her senaryodan sonra **değişmezler** denetlenir:
  - Her cüzdanda `bakiye = Σ CREDIT − Σ DEBIT − Σ CAPTURE` (ledger mutabakatı)
  - `bloke = Σ aktif bloke`, `bakiye ≥ bloke ≥ 0`
  - **Para korunumu:** `Σ yüklenen = Σ bakiye + Σ tahsil edilen`
  - Tamamlanan her seansta `tahsilat = blokeden tahsil edilen ≤ bloke`
  - Peron başına en fazla bir aktif seans
  - Yaşam döngüsü bitince açık bloke ve bitmemiş seans kalmaz

Ölçek ortam değişkenleriyle değişir: `LOAD_USERS`, `LOAD_BAYS`, `LOAD_ROUNDS`, `LOAD_OVERLOAD`, `LOAD_POOL`.

## Senaryolar ve sonuçlar (Windows geliştirme makinesi, Docker PostgreSQL 17, havuz 10)

| Senaryo | Yük | Sonuç | Başlatma gecikmesi |
|---|---|---|---|
| **Kalabalık istasyon** | 200 müşteri × 20 peron, 3 tur (600 istek); her turda ACK, çift ACK, bitiş, çift bitiş ve müşteri durdurma aynı anda | Her turda her peronda tam 1 kazanan (60 seans), kalanlar `BAY_BUSY`. Beklenmeyen hata yok. Tüm değişmezler tuttu; tur sonunda açık bloke yok | p50 0,8 sn · p95 1,0 sn |
| **Çift harcama** | Yalnız 1 seanslık bakiyesi olan 50 müşteri, her biri aynı anda 10 farklı perona (500 istek) | Hiçbir müşteri 1'den fazla seans açamadı; kalanlar `INSUFFICIENT_FUNDS` / `BAY_BUSY`. Değişmezler tuttu | p50 1,7 sn · p95 1,75 sn |
| **Aşırı yük** | 1500 eşzamanlı başlatma, 20 peron | 20 seans açıldı; ~%50 istek `P2028` ile reddedildi (işlem 2 sn içinde başlayamadı). **Değişmezler yine tuttu**: para bozulmadı, çift seans yok | p50 3,5 sn · p95 3,9 sn |

Sonuç: **Double spending ve kayıp ödemeli seans gözlenmedi**, aşırı yükte de. Korumalar: cüzdanda koşullu UPDATE (bakiye kontrolü ve bloke tek ifade), peron başına aktif seans için kısmi unique index, DB CHECK kısıtları, seans satırı `FOR UPDATE`, cihaz mesajlarında inbox tekilleştirmesi.

## Bulgular

1. **Aşırı yükte 500 dönüyordu → düzeltildi.** Havuz dolunca Prisma `P2028` fırlatıyor, API bunu `500 INTERNAL_ERROR` olarak döndürüyordu. İşlem hiç başlamadığı (ya da zaman aşımıyla geri alındığı) için yan etkisi yoktur; artık `503 SERVICE_BUSY` + `Retry-After: 1` döner ve yığın izi yerine tek satır uyarı loglanır. Para uçları `Idempotency-Key` ile aynı isteği güvenle tekrarlar.
2. **Havuz boyutu darboğaz değil.** `DB_POOL_MAX` (yeni, varsayılan 10) 10 / 20 / 40 ile aşırı yük senaryosu aynı sonucu verdi. Darboğaz, aynı perona yığılan isteklerin unique index kilidi için sıraya girmesi. Gerçekte bir perona aynı anda çok sayıda müşteri başlatma gönderemez (QR peronun önünde); bu senaryo sistemin sınırını göstermek içindir.
3. **İyileştirme fırsatı (uygulanmadı):** Kaybeden istekler bloke alıp işlem sonunda geri alınıyor. İşlemden önce "peronda aktif seans var mı" ön kontrolü, meşgul perona gelen istekleri bağlantı tutmadan reddederdi (doğruluk yine unique index'te kalır). Pilot ölçeğinde gerek görülmedi.
4. **Bilgi:** Aynı müşteri bakiyesi yetiyorsa iki farklı peronda aynı anda seans açabilir (kullanıcı başına tek aktif seans kısıtı yok). Para açısından güvenli (her seans kendi blokesini alır); iş kuralı olarak istenmiyorsa ayrıca eklenmeli.

## Pilot için kapasite yorumu

Pilot istasyonda eşzamanlı başlatma sayısı peron sayısıyla sınırlı (4–8). Test, 200–500 eşzamanlı başlatmayı tüm kurallar tutarak ~1–2 sn'de işledi; pilot yükünün iki mertebe üstü. Üretim sunucusunda sayılar farklı olacaktır; canlıdan önce aynı test hedef sunucuda bir kez çalıştırılmalı.
