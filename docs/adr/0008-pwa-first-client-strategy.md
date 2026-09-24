# ADR-0008: Istemci Stratejisi — Once PWA, Native Uygulama Sonra

**Durum:** Kabul edildi
**Tarih:** 2026-09-24

## Baglam

QWASH musterisi cogunlukla istasyona ilk kez gelen, araciyla peronda bekleyen ve islemi bir-iki dakikada bitirmek isteyen bir kullanicidir. Istemci icin iki secenek vardi: native mobil uygulama (iOS + Android) veya tarayici tabanli PWA.

## Karar

Ilk surumde **musteri istemcisi PWA** olacak. Native uygulama, saha verisi gerektirdigini gosterirse ayni backend API'si uzerine sonradan eklenecek.

## Gerekce

| Kriter | PWA | Native |
|---|---|---|
| Ilk kullanim surtunmesi | QR okut, ac, kullan. Kurulum yok. | Store'a git, indir, hesap ac. Peronda musteri kaybi yuksek. |
| Odeme (Iyzico 3D Secure) | Tarayici yonlendirmesi, dogrudan calisir. | WebView/ozel entegrasyon gerekir. |
| Yayin ve guncelleme | Deploy = herkeste guncel. | Store incelemesi, surum parcalanmasi. |
| Maliyet | Tek kod tabani (Next.js). | iOS + Android ayri bakim (veya cross-platform arac). |
| ESP32 baglantisi | Istemci cihazla konusmaz, her sey backend uzerinden gecer; native'in donanim avantaji yok. | Ayni. |
| Push bildirim | Android'de iyi, iOS'ta sinirli (yalniz ana ekrana eklenirse). | Tam destek. |
| Store gorunurlugu | Yok. | Var. |

Istemci ESP32 ile dogrudan konusmadigi icin (Web Bluetooth, yerel ag vb. gerekmez) native'in teknik ustunlugu yalnizca push bildirim ve store gorunurlugudur. Bunlar MVP icin kritik degildir.

## Sonuclar

- Backend API'si istemciden bagimsiz tasarlanir: Tum is kurallari sunucuda, istemci ince kalir. Boylece native uygulama sonradan ayni API'ye baglanabilir.
- Oturum ve seans durumu Socket.IO ile alinir; PWA arka plana dusunce baglanti kopabilir. Istemci yeniden acildiginda seans durumunu REST ile geri yuklemelidir (`GET /sessions/active`).
- Seans bitisi bildirimi icin MVP'de yalnizca sayfa ici gosterim kullanilir. Web Push, Faz 5'te opsiyonel eklenir.
- Native uygulama karari icin degerlendirme olcutu: Pilot verisinde push bildirimine duyulan ihtiyac, tekrar eden kullanici orani ve store gorunurlugu talebi.

## Alternatifler

- **Native (React Native/Expo):** Erken maliyet ve ilk kullanim surtunmesi MVP'nin hedefiyle uyusmuyor. Ertelendi, reddedilmedi.
- **Hem PWA hem native ayni anda:** Kaynak bolunur, cekirdek akis (para + donanim) gec dogrulanir. Reddedildi.
