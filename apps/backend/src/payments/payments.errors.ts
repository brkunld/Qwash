// Odeme alan hatalari. HTTP karsiliklari http/api-envelope.ts'te.

export class PaymentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class PaymentsDisabledError extends PaymentError {
  constructor() {
    super('PAYMENTS_DISABLED', 'Kartla bakiye yukleme su an kullanilamiyor.');
  }
}

export class AccountNotActiveError extends PaymentError {
  constructor() {
    super('ACCOUNT_NOT_ACTIVE', 'Hesap aktif degil; bakiye yuklenemez.');
  }
}

export class EmailNotVerifiedError extends PaymentError {
  constructor() {
    super('EMAIL_NOT_VERIFIED', 'Bakiye yuklemek icin once e-posta adresinizi dogrulayin.');
  }
}

export class FullNameRequiredError extends PaymentError {
  constructor() {
    super('FULL_NAME_REQUIRED', 'Bakiye yuklemeden once profilinize ad soyad ekleyin.');
  }
}

export class TopUpAmountOutOfRangeError extends PaymentError {
  constructor(minKurus: number, maxKurus: number) {
    super('TOPUP_AMOUNT_OUT_OF_RANGE', 'Yukleme tutari izin verilen aralikta degil.', {
      minKurus,
      maxKurus,
    });
  }
}

export class TopUpNotFoundError extends PaymentError {
  constructor() {
    super('TOPUP_NOT_FOUND', 'Yukleme bulunamadi.');
  }
}

export class IdempotencyKeyRequiredError extends PaymentError {
  constructor() {
    super('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key basligi zorunlu.');
  }
}

export class TopUpIdempotencyConflictError extends PaymentError {
  constructor() {
    super('IDEMPOTENCY_CONFLICT', 'Ayni Idempotency-Key farkli bir tutarla kullanildi.');
  }
}

export class PaymentProviderUnavailableError extends PaymentError {
  constructor() {
    super(
      'PAYMENT_PROVIDER_UNAVAILABLE',
      'Odeme saglayicisina ulasilamadi. Biraz sonra tekrar deneyin.',
    );
  }
}
