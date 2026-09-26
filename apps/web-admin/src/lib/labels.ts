// Iade talebi etiketleri (liste ve detay sayfasi ortak kullanir).

export const REASON_LABEL = {
  ACCOUNT_DELETION: 'Hesap silme',
  SERVICE_FAILURE: 'Teknik hata',
} as const;

export const REQUEST_TONE = { REQUESTED: 'amber', COMPLETED: 'green', REJECTED: 'red' } as const;

export const REQUEST_LABEL = {
  REQUESTED: 'Bekliyor',
  COMPLETED: 'Tamamlandı',
  REJECTED: 'Reddedildi',
} as const;

export const METHOD_LABEL = {
  CARD: 'Karta iade (Iyzico)',
  IBAN: "IBAN'a EFT",
  CASH_AT_STATION: 'Kasadan nakit',
} as const;

export const PAYOUT_TONE = {
  PENDING: 'slate',
  IN_FLIGHT: 'amber',
  DONE: 'green',
  FAILED: 'red',
} as const;

export const PAYOUT_LABEL = {
  PENDING: 'Bekliyor',
  IN_FLIGHT: 'Sonucu belirsiz',
  DONE: 'Ödendi',
  FAILED: 'Başarısız',
} as const;
