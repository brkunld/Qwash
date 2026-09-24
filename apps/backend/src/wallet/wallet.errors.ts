// Cuzdan alan hatalari. HTTP katmani (Faz 5) bunlari uygun durum kodlarina cevirir.

export class WalletError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class WalletNotFoundError extends WalletError {
  constructor(walletId: string) {
    super('WALLET_NOT_FOUND', `Cuzdan bulunamadi: ${walletId}`);
  }
}

export class InsufficientFundsError extends WalletError {
  constructor(
    readonly requestedKurus: number,
    readonly availableKurus: number,
  ) {
    super(
      'INSUFFICIENT_FUNDS',
      `Yetersiz bakiye: istenen ${requestedKurus} kurus, kullanilabilir ${availableKurus} kurus`,
    );
  }
}

export class HoldNotFoundError extends WalletError {
  constructor(holdId: string) {
    super('HOLD_NOT_FOUND', `Bloke bulunamadi: ${holdId}`);
  }
}

export class HoldAlreadySettledError extends WalletError {
  constructor(holdId: string, status: string) {
    super('HOLD_ALREADY_SETTLED', `Bloke zaten kapatilmis (${status}): ${holdId}`);
  }
}

export class CaptureExceedsHoldError extends WalletError {
  constructor(captureKurus: number, holdKurus: number) {
    super(
      'CAPTURE_EXCEEDS_HOLD',
      `Tahsil edilecek tutar (${captureKurus}) bloke tutarini (${holdKurus}) asiyor`,
    );
  }
}

export class IdempotencyConflictError extends WalletError {
  constructor(key: string) {
    super(
      'IDEMPOTENCY_CONFLICT',
      `Ayni idempotency anahtari farkli parametrelerle tekrar kullanildi: ${key}`,
    );
  }
}

export class InvalidAmountError extends WalletError {
  constructor(value: number) {
    super('INVALID_AMOUNT', `Tutar pozitif tam sayi (kurus) olmali: ${value}`);
  }
}
