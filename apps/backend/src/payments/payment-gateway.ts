// Odeme saglayicisi arayuzu (ADR-0003). Uygulama: iyzico.gateway.ts; testlerde sahte uygulama.

export interface CheckoutBuyer {
  id: string;
  fullName: string | null;
  email: string;
  phoneNumber: string | null;
  ip: string | null;
}

export interface InitializeCheckoutInput {
  /** Bizim CardTopUp.id'miz; Iyzico'da conversationId ve basketId olarak gider. */
  topUpId: string;
  amountKurus: number;
  callbackUrl: string;
  buyer: CheckoutBuyer;
}

export interface InitializedCheckout {
  token: string;
  paymentPageUrl: string;
}

export type CheckoutOutcome =
  /** Odeme alindi. Tutar/sepet kontrolu cagiranin isidir. */
  | {
      kind: 'SUCCESS';
      paymentId: string;
      paymentTransactionId: string | null;
      paidKurus: number;
      currency: string;
      basketId: string;
      conversationId: string;
    }
  /** Odeme kesin olarak basarisiz. */
  | { kind: 'FAILURE'; reason: string }
  /** Henuz sonuc yok (form acik, 3DS suruyor, fraud incelemesi). */
  | { kind: 'PENDING'; reason: string };

export abstract class PaymentGateway {
  abstract initializeCheckout(input: InitializeCheckoutInput): Promise<InitializedCheckout>;
  /** Sonucu saglayicidan sorar; yanit imzasini dogrular. */
  abstract retrieveCheckout(token: string): Promise<CheckoutOutcome>;
  /** Webhook imzasini dogrular. */
  abstract verifyWebhook(body: unknown, signature: string | undefined): boolean;
}

export class PaymentProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}
