import { ApiError } from './api';

// Operatore gosterilen hata metinleri. Sunucu mesajlari ASCII ve teknik; bilinen kodlar
// burada Turkce ve eylem odakli yazilir. Bilinmeyen kodda sunucu mesaji gosterilir
// (admin mesajlari operator icin yazilmistir).
const MESSAGES: Record<string, string> = {
  NETWORK_ERROR: 'Sunucuya ulaşılamadı. API çalışıyor mu?',
  RATE_LIMITED: 'Çok fazla deneme. Biraz bekleyin.',
  INVALID_CREDENTIALS: 'E-posta veya şifre hatalı.',
  UNAUTHENTICATED: 'Oturum süresi doldu. Yeniden giriş yapın.',
  ACCOUNT_DISABLED: 'Hesap kullanıma kapalı.',
  ADMIN_FORBIDDEN: 'Bu işlem için yetkiniz yok.',
  IDEMPOTENCY_KEY_REQUIRED: 'İstek anahtarı eksik. Sayfayı yenileyin.',
  IDEMPOTENCY_CONFLICT:
    'Bu istek farklı bir işlem için kullanılmış. Sayfayı yenileyip tekrar deneyin.',
  USER_NOT_FOUND: 'Kullanıcı bulunamadı.',
  STATION_NOT_FOUND: 'İstasyon bulunamadı.',
  TARGET_ACCOUNT_NOT_ACTIVE: 'Müşteri hesabı aktif değil; bakiye işlemi yapılamaz.',
  CASH_AMOUNT_OUT_OF_RANGE: 'Tutar izin verilen üst sınırı aşıyor.',
  INSUFFICIENT_AVAILABLE: 'Kullanılabilir bakiye yetersiz; bloke edilmiş tutardan düşülemez.',
  PROGRAM_CODE_TAKEN: 'Bu kod bu istasyonda kullanılmış (silinmiş program da olabilir).',
  RELAY_CONFLICT: 'Aynı röle kanalı iki programa atanamaz.',
  PAYOUT_STATE: 'Bu parça şu anki durumunda bu işleme uygun değil.',
  REFUND_REQUEST_CLOSED: 'İade talebi zaten sonuçlanmış.',
  REFUND_HAS_PAID_PARTS: 'Ödenmiş veya sonucu belirsiz parçası olan talep reddedilemez.',
  STATION_REQUIRED: 'Kasadan ödemede istasyon seçin.',
  SESSION_NOT_ACTIVE: 'Seans aktif değil; durdurulacak bir şey yok.',
  PAYMENTS_DISABLED: 'Iyzico anahtarları tanımlı değil; kart iadesi yapılamaz.',
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'VALIDATION_FAILED' && error.message) return error.message;
    return MESSAGES[error.code] ?? (error.message || 'Bir hata oluştu.');
  }
  return 'Bir hata oluştu.';
}

export function errorCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}
