// Admin islemleri hatalari (ADR-0011). HTTP karsiliklari http/api-envelope.ts'te.
// Mesajlar operatore gosterilir.

export class AdminError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AdminForbiddenError extends AdminError {
  constructor() {
    super('ADMIN_FORBIDDEN', 'Bu islem icin yetkiniz yok.');
  }
}

export class AdminUserNotFoundError extends AdminError {
  constructor() {
    super('USER_NOT_FOUND', 'Kullanici bulunamadi.');
  }
}

export class StationNotFoundError extends AdminError {
  constructor() {
    super('STATION_NOT_FOUND', 'Istasyon bulunamadi.');
  }
}

export class TargetAccountNotActiveError extends AdminError {
  constructor() {
    super('TARGET_ACCOUNT_NOT_ACTIVE', 'Musteri hesabi aktif degil; bakiye islemi yapilamaz.');
  }
}

export class CashAmountOutOfRangeError extends AdminError {
  constructor(maxKurus: number) {
    super('CASH_AMOUNT_OUT_OF_RANGE', 'Nakit yukleme tutari ust siniri asiyor.', { maxKurus });
  }
}

export class AdminIdempotencyConflictError extends AdminError {
  constructor() {
    super(
      'IDEMPOTENCY_CONFLICT',
      'Bu istek anahtari farkli bir islem icin kullanilmis. Sayfayi yenileyip tekrar deneyin.',
    );
  }
}

export class RefundRequestNotFoundError extends AdminError {
  constructor() {
    super('REFUND_REQUEST_NOT_FOUND', 'Iade talebi bulunamadi.');
  }
}

export class RefundRequestClosedError extends AdminError {
  constructor() {
    super('REFUND_REQUEST_CLOSED', 'Iade talebi zaten sonuclanmis.');
  }
}

export class PayoutNotFoundError extends AdminError {
  constructor() {
    super('PAYOUT_NOT_FOUND', 'Iade parcasi bulunamadi.');
  }
}

export class PayoutStateError extends AdminError {
  constructor(message: string) {
    super('PAYOUT_STATE', message);
  }
}

export class RefundHasPaidPartsError extends AdminError {
  constructor() {
    super(
      'REFUND_HAS_PAID_PARTS',
      'Odenmis veya sonucu belirsiz parcasi olan talep reddedilemez; once parcalari sonuclandirin.',
    );
  }
}

export class StationRequiredError extends AdminError {
  constructor() {
    super('STATION_REQUIRED', 'Kasadan odemede istasyon secilmeli (kasa raporu icin).');
  }
}
