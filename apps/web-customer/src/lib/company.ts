// Yasal metinlerde gecen isletme bilgileri. Gercek degerler girilince `[` ile baslayan
// alanlar kalmaz ve yasal sayfalardaki "taslak" uyarisi kendiliginden kaybolur.
export const COMPANY = {
  brand: 'QWash',
  legalName: '[Şirket unvanı]',
  address: '[Açık adres]',
  email: '[destek e-posta adresi]',
  phone: '[telefon]',
  taxOffice: '[Vergi dairesi / numarası]',
  mersis: '[MERSİS numarası]',
} as const;

export const LEGAL_UPDATED = '26 Eylül 2026';

/** Yer tutucu kaldiysa metin yayina hazir degildir. */
export const LEGAL_IS_DRAFT = Object.values(COMPANY).some((v) => v.startsWith('['));
