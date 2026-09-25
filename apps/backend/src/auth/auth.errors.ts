// Kimlik dogrulama hatalari. HTTP karsiliklari api-error.filter.ts'te.
// Mesajlar musteriye gosterilebilir; hesap varligini sizdirmayacak sekilde yazildi.

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class EmailTakenError extends AuthError {
  constructor() {
    super('EMAIL_TAKEN', 'Bu e-posta ile kayitli bir hesap var.');
  }
}

export class InvalidCredentialsError extends AuthError {
  constructor() {
    super('INVALID_CREDENTIALS', 'E-posta veya sifre hatali.');
  }
}

export class AccountDisabledError extends AuthError {
  constructor() {
    super('ACCOUNT_DISABLED', 'Hesap kullanima kapali.');
  }
}

export class InvalidTokenError extends AuthError {
  constructor() {
    super('INVALID_TOKEN', 'Baglanti gecersiz veya suresi dolmus.');
  }
}

export class UnauthenticatedError extends AuthError {
  constructor() {
    super('UNAUTHENTICATED', 'Oturum gecersiz; tekrar giris yapin.');
  }
}

export class GoogleLoginDisabledError extends AuthError {
  constructor() {
    super('GOOGLE_LOGIN_DISABLED', 'Google ile giris su an kullanilamiyor.');
  }
}

export class GoogleEmailNotVerifiedError extends AuthError {
  constructor() {
    super('GOOGLE_EMAIL_NOT_VERIFIED', 'Google hesabinin e-postasi dogrulanmamis.');
  }
}

export class AccountLinkRequiredError extends AuthError {
  constructor() {
    super(
      'ACCOUNT_LINK_REQUIRED',
      'Bu e-posta ile dogrulanmamis bir hesap var. Once e-posta ve sifreyle girip e-postanizi dogrulayin.',
    );
  }
}
