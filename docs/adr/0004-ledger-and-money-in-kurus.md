# ADR-0004: Finansal Model — Double-Entry Ledger ve Kuruş (Integer) Standardı

* **Durum:** Kabul Edildi
* **Tarih:** 2026-09-17
* **Karar Veren:** Proje Lideri

---

## Bağlam

Yıkama istasyonunda para yükleme, bakiye bloke etme (hold) ve seans süresince ücret düşme işlemleri yapılmaktadır.

İkili kayan noktalı sayılar (IEEE 754 Floating Point — `float`, `double`) bilgisayar biliminde `0.1 + 0.2 = 0.30000000000000004` gibi yuvarlama hatalarına yol açar. Sadece tek bir `balance` kolonunu güncellemek ise geçmişe dönük denetimi (audit trail) imkansız kılar.

## Karar

1. **Para Temsili:** Tüm finansal değerler para biriminin en küçük alt birimi olan **KURUŞ (Integer/BigInt)** cinsinden tutulur. 100 TL = `10000` kuruş. DTO ve API seviyesinde float değer taşınmaz.
2. **Double-Entry Ledger:** Kullanıcının bakiyesi tek başına duran bir sayı değildir. Cüzdan üzerindeki her hareket (`CREDIT`, `HOLD`, `CAPTURE`, `RELEASE`) immutable bir `LedgerEntry` kaydı üretir.
3. **Database Constraints:** Veritabanı seviyesinde `CHECK (balanceKurus >= holdKurus AND holdKurus >= 0)` constraint'i zorunlu kılınmıştır.
4. **Tek Cüzdan & Saniyelik Tarife:** Kullanıcı için ayrı servis kredileri (su kredisi, köpük kredisi) tutulmaz; tek bir TL (kuruş) bakiyesi bulunur. Yıkama programlarının saniyelik birim fiyatları (Su: 50 kr/sn, Köpük: 100 kr/sn vb.) admin tarafından kuruş cinsinden yönetilir ve harcanan saniye ile çarpılarak bu tek bakiyeden düşülür.

## Gerekçe

| Kriter | Float/Double | Integer (Kuruş) |
|---|---|---|
| Yuvarlama hatası riski | Yüksek (IEEE 754) | Yok |
| Denetim izi (Audit Trail) | Tek kolon, geçmiş yok | Her hareket immutable kayıt |
| DB düzeyinde tutarlılık | Constraint yazılamaz | CHECK constraint uygulanabilir |
| Frontend formatlaması | Karmaşık | `kuruş / 100` → `Intl.NumberFormat` |

## Sonuçlar

* Yuvarlama ve kuruş kayıpları %100 engellenir.
* Finansal uyuşmazlık durumunda geçmiş hareketler toplanarak bakiye her an doğrulanabilir.
* Frontend kullanıcıya tutar gösterirken kuruşu 100'e bölerek formatlamak zorundadır (`Intl.NumberFormat`).
