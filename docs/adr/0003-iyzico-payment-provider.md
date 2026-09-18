# ADR-0003: İyzico (Stripe / Diğer Ödeme Sağlayıcıları Yerine)

* **Durum:** Kabul Edildi
* **Tarih:** 2026-09-17
* **Karar Veren:** Proje Lideri

---

## Bağlam

QWASH'ın müşteri bakiye yükleme akışı için 3D Secure destekli bir ödeme sağlayıcısı gerekmektedir. Değerlendirilen alternatifler:

1. **Stripe** — Global lider, kapsamlı API
2. **PayTR** — Türk sağlayıcı, orta düzey API
3. **İyzico** — Türk sağlayıcı, Iyzipay markalı, native 3DS

## Karar

**İyzico** (Iyzipay) seçilmiştir.

## Gerekçe

| Kriter | Stripe | PayTR | İyzico |
|---|---|---|---|
| Türkiye 3D Secure desteği | Evet (PSD2 tabanlı) | Evet | Evet (native) |
| Türkiye yasal uyum (BDDK) | Dolaylı | Evet | Evet |
| Türk bankası entegrasyonu | Sınırlı | İyi | Mükemmel |
| Türkçe destek & dokümantasyon | Hayır | Kısmi | Evet |
| Sandbox kalitesi | Mükemmel | Orta | İyi |
| Kurumsal sözleşme zorluğu | Orta | Kolay | Kolay |

Stripe, Türk bankaları ve BDDK gereklilikleri açısından Iyzico kadar uyumlu değildir. V1 hedef pazarı yalnızca Türkiye olduğundan İyzico net avantaj sağlar.

## Sonuçlar

* Ödeme akışı İyzico 3D Secure form entegrasyonu üzerinden çalışır.
* Webhook imzası HMAC-SHA256 ile doğrulanır (bkz. [API.md § 7](../API.md)).
* İleride multi-currency veya uluslararası genişleme gerekirse Stripe entegrasyonu `PaymentGateway` interface'i arkasına adapte edilebilir.
