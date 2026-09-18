# ADR-0001: Modular Monolith (Microservices Yerine)

* **Durum:** Kabul Edildi
* **Tarih:** 2026-09-17
* **Karar Veren:** Proje Lideri

---

## Bağlam

QWASH platformu başlangıç aşamasında birden fazla domain içermektedir: Kimlik doğrulama, cüzdan/ödeme, IoT seans yönetimi, admin telemetri. Bu domainler doğal olarak mikroservis adayı gibi görünebilir.

## Karar

V1 için **Modular Monolith** mimarisi seçilmiştir. Backend tek bir NestJS uygulamasıdır; ancak her domain (auth, wallet, session, iot, admin) bağımsız NestJS modülleri olarak ayrıştırılmıştır.

## Gerekçe

| Kriter | Microservices | Modular Monolith |
|---|---|---|
| Deployment karmaşıklığı | Yüksek (her servis ayrı container) | Düşük (tek container) |
| Network gecikmesi | Yüksek (servislerarası HTTP/gRPC) | Yok (in-process çağrı) |
| Geliştirici deneyimi | Karmaşık (distributed tracing, servis discovery) | Basit (tek kod tabanı) |
| Test edilebilirlik | Zor (contract test, integration harness) | Kolay (in-process mock) |
| Erken aşama esneklik | Düşük (domain sınırları değişince büyük refactor) | Yüksek (modüller yeniden düzenlenebilir) |

Başarı kanıtlandığında (`>10 istasyon, >1000 günlük seans`) modüller bağımsız servisler olarak çıkarılabilir. Modül sınırları bu dönüşüme hazırlıklı tasarlanmıştır.

## Sonuçlar

* Her modül kendi klasöründe (`apps/backend/src/modules/<domain>/`) tutulur.
* Modüller arası doğrudan import yasaktır — yalnızca NestJS DI container üzerinden haberleşirler.
* Paylaşılan tipler `@qwash/contracts` paketi üzerinden sağlanır.
