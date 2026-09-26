import { ApiError } from './api';

// Musteriye gosterilen hata metinleri. Sunucu mesajlari teknik ve ASCII oldugu icin
// bilinen kodlar burada Turkce ve eylem odakli yazilir (ROADMAP Faz 5: anlasilir hata).
const MESSAGES: Record<string, string> = {
  NETWORK_ERROR: 'Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.',
  RATE_LIMITED: 'Çok fazla deneme yapıldı. Biraz bekleyip tekrar deneyin.',
  INVALID_CREDENTIALS: 'E-posta veya şifre hatalı.',
  EMAIL_TAKEN: 'Bu e-posta ile zaten bir hesap var. Giriş yapmayı deneyin.',
  ACCOUNT_DISABLED: 'Hesabınız kullanıma kapalı. Destek ile iletişime geçin.',
  GOOGLE_LOGIN_DISABLED: 'Google ile giriş şu an kapalı. E-posta ve şifreyle giriş yapabilirsiniz.',
  GOOGLE_EMAIL_NOT_VERIFIED: 'Google hesabınızın e-posta adresi doğrulanmamış.',
  ACCOUNT_NOT_ACTIVE: 'Hesabınız kapatılmış.',
  INVALID_TOKEN:
    'Doğrulama geçersiz, süresi dolmuş veya daha önce kullanılmış. Lütfen tekrar deneyin.',
  EMAIL_NOT_VERIFIED: 'Bakiye yüklemek için önce e-posta adresinizi doğrulayın.',
  BAY_NOT_FOUND: 'Bu peron bulunamadı. Peron ekranındaki QR kodu yeniden okutun.',
  BAY_BUSY: 'Bu peronda şu an başka bir yıkama sürüyor.',
  BAY_UNAVAILABLE: 'Peron şu an kullanılamıyor. Başka bir peron deneyin.',
  PROGRAM_NOT_AVAILABLE: 'Bu program şu an bu peronda kullanılamıyor.',
  INSUFFICIENT_FUNDS: 'Bakiyeniz bu süre için yetersiz. Süreyi kısaltın veya bakiye yükleyin.',
  INVALID_DURATION: 'Geçersiz süre seçildi.',
  SESSION_NOT_FOUND: 'Yıkama kaydı bulunamadı.',
  PAYMENTS_DISABLED: 'Kartla yükleme şu an kapalı. Kasadan nakit yükleyebilirsiniz.',
  PAYMENT_PROVIDER_UNAVAILABLE: 'Ödeme sağlayıcısına ulaşılamadı. Biraz sonra tekrar deneyin.',
  TOPUP_AMOUNT_OUT_OF_RANGE: 'Yükleme tutarı izin verilen aralıkta değil.',
  FULL_NAME_REQUIRED: 'Kartla yüklemeden önce ad soyad bilginizi girin.',
  IDEMPOTENCY_CONFLICT: 'İstek çakıştı. Sayfayı yenileyip tekrar deneyin.',
  ACTIVE_HOLD: 'Süren bir yıkama varken hesap silinemez.',
  TOPUP_IN_PROGRESS: 'Sonuçlanmamış bir bakiye yüklemesi varken hesap silinemez.',
  IBAN_REQUIRED: 'İadenin bir kısmı için kendi adınıza kayıtlı IBAN gerekiyor.',
  PASSWORD_REQUIRED: 'Devam etmek için şifrenizi girin.',
  VALIDATION_FAILED: 'Girilen bilgileri kontrol edin.',
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'VALIDATION_FAILED' && error.message) return error.message;
    return MESSAGES[error.code] ?? 'Bir hata oluştu. Lütfen tekrar deneyin.';
  }
  return 'Bir hata oluştu. Lütfen tekrar deneyin.';
}

export function errorCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}
