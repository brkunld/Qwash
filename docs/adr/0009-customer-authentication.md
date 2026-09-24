# ADR-0009: Musteri Kimlik Dogrulama — E-posta/Sifre ve Google, Misafir Yok

**Durum:** Kabul edildi
**Tarih:** 2026-09-25

## Baglam

Musteri bir cuzdan bakiyesi tasir ve odeme yapar. Kimlik, hem finansal kayitlarin sahibini hem de bakiyenin cihazlar arasinda korunmasini belirler. Secenekler: telefon + SMS OTP, e-posta/sifre, sosyal giris (Google), misafir kullanim.

## Karar

1. **Iki giris yontemi:** E-posta + sifre ve Google ile giris. Ikisi ayni `User` kaydina baglanabilir.
2. **Misafir kullanim yok.** Bakiye ve ledger her zaman bir hesaba aittir. Bu, para akisinin denetlenebilirligini ve iade/destek surecini sadelestirir.
3. **Telefon numarasi MVP'de zorunlu degil.** Google girisi telefon numarasi dondurmez, bu yuzden `User.phoneNumber` opsiyonel kalir. Numara gerekirse (destek, SMS, odeme saglayicisinin zorunlu alanlari) profil adiminda kullanicidan istenir ve dogrulanir.
4. **E-posta dogrulamasi zorunlu.** E-posta/sifre ile acilan hesap, e-posta dogrulanmadan bakiye yukleyemez. Google hesabinin e-postasi `email_verified` ise dogrulanmis sayilir.
5. **Hesap birlestirme:** Ayni e-postayla Google girisi yapilirsa yalniz e-posta dogrulanmis ise mevcut hesaba baglanir; aksi halde baglanmaz (hesap ele gecirme riski).

## Gerekce

- Telefon + SMS OTP hem maliyetli hem de Turkiye'de operator/saglayici bagimliligi getirir. MVP icin gereksiz.
- Misafir kullanimda bakiye kaybi, iade ve dolandiricilik takibi zorlasir.
- Google girisi, peronda sifre yazma surtunmesini azaltir ve e-posta dogrulamasini hazir getirir.

## Sonuclar

- `User.passwordHash` nullable olur (yalniz Google ile acilan hesapta sifre yok). Kimlik yontemleri ayri `AuthIdentity` tablosunda tutulur (`provider`, `providerUserId`).
- Yeni endpoint'ler: Google giris, e-posta dogrulama, sifre sifirlama (bkz. `API.md`).
- Iyzico odeme cagrisinda zorunlu alici alanlarinin (ad, e-posta, GSM vb.) hangilerinin telefon gerektirdigi **Faz 5 basinda sandbox'ta dogrulanacak**. Telefon zorunlu cikarsa, ilk bakiye yuklemeden once profilden istenir.
- Google icin OAuth client ayari ve onay ekrani (consent screen) gerekir; bu bir Faz 5 hazirlik maddesidir.
- KVKK: Toplanan veri minimumdur (ad, e-posta, opsiyonel telefon). Aydinlatma metni ve hesap silme akisi Faz 5 kapsamindadir.

## Alternatifler

- **Telefon + OTP:** Ertelendi. Ihtiyac dogarsa ek yontem olarak eklenebilir; `AuthIdentity` modeli buna hazirdir.
- **Misafir:** Reddedildi (yukaridaki gerekce).
