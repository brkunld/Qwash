// Seans alan hatalari. HTTP katmani (Faz 5) bunlari uygun durum kodlarina cevirir.

export class SessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BayNotFoundError extends SessionError {
  constructor(bayCode: string) {
    super('BAY_NOT_FOUND', `Peron bulunamadi: ${bayCode}`);
  }
}

export class ProgramNotAvailableError extends SessionError {
  constructor(bayCode: string, programCode: string) {
    super('PROGRAM_NOT_AVAILABLE', `Program bu peronda kullanilamaz: ${bayCode}/${programCode}`);
  }
}

export class BayUnavailableError extends SessionError {
  constructor(bayCode: string, reason: string) {
    super('BAY_UNAVAILABLE', `Peron su an kullanilamaz (${reason}): ${bayCode}`);
  }
}

export class BayBusyError extends SessionError {
  constructor(bayCode: string) {
    super('BAY_BUSY', `Peronda devam eden bir seans var: ${bayCode}`);
  }
}

export class InvalidDurationError extends SessionError {
  constructor(durationSec: number, max: number) {
    super('INVALID_DURATION', `Sure 1..${max} saniye arasinda olmali: ${durationSec}`);
  }
}

export class SessionNotFoundError extends SessionError {
  constructor(sessionId: string) {
    super('SESSION_NOT_FOUND', `Seans bulunamadi: ${sessionId}`);
  }
}

export class SessionAccountNotActiveError extends SessionError {
  constructor() {
    super('ACCOUNT_NOT_ACTIVE', 'Hesap kapali; seans baslatilamaz.');
  }
}

export class SessionIdempotencyConflictError extends SessionError {
  constructor(key: string) {
    super(
      'IDEMPOTENCY_CONFLICT',
      `Ayni idempotency anahtari farkli parametrelerle tekrar kullanildi: ${key}`,
    );
  }
}
