// Hesap silme / iade talebi hatalari. HTTP karsiliklari http/api-envelope.ts'te.

export class AccountError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ActiveHoldError extends AccountError {
  constructor() {
    super('ACTIVE_HOLD', 'Devam eden bir yikama veya iade talebi varken hesap silinemez.');
  }
}

export class TopUpInProgressError extends AccountError {
  constructor() {
    super(
      'TOPUP_IN_PROGRESS',
      'Sonuclanmamis bir bakiye yuklemesi var. Sonucu en gec 24 saat icinde netlesir; sonra tekrar deneyin.',
    );
  }
}

export class BalanceDecisionRequiredError extends AccountError {
  constructor() {
    super(
      'BALANCE_DECISION_REQUIRED',
      'Hesapta bakiye var: feragat veya iade seceneklerinden birini secin.',
    );
  }
}

export class ForfeitConfirmationRequiredError extends AccountError {
  constructor() {
    super('FORFEIT_CONFIRMATION_REQUIRED', 'Bakiyeden feragat icin onay kutusunu isaretleyin.');
  }
}

export class IbanRequiredError extends AccountError {
  constructor() {
    super(
      'IBAN_REQUIRED',
      'Yuklemenizin uzerinden 1 yildan uzun sure gectigi icin bankacilik kurallari geregi karta otomatik iade yapilamamaktadir. Lutfen kendi adiniza kayitli IBAN giriniz.',
    );
  }
}

export class PasswordRequiredError extends AccountError {
  constructor() {
    super('PASSWORD_REQUIRED', 'Hesabi silmek icin sifrenizi girin.');
  }
}

export class HolderNameRequiredError extends AccountError {
  constructor() {
    super(
      'HOLDER_NAME_REQUIRED',
      'IBAN iadesi icin profilde ad soyad kayitli olmali. Destekle iletisime gecin.',
    );
  }
}
