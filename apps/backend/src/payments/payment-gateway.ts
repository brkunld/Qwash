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
      /** Iyzico sonuc yanitinda gelmeyebilir; baglayici alan basketId. */
      conversationId: string | null;
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
  /**
   * Alinmis odemeyi geri verir: once ayni gun iptal, olmazsa tam iade.
   * Basarisizsa PaymentProviderError firlatir (cagiran daha sonra yeniden dener).
   */
  abstract reversePayment(input: ReversePaymentInput): Promise<'CANCELLED' | 'REFUNDED'>;
  /**
   * Kart islemine kismi iade (admin iade isleme, ADR-0011 madde 5).
   * Iyzico acikca reddederse REJECTED doner. Sonuc belirsizse (ag, zaman asimi, okunamayan
   * yanit) PaymentProviderError firlatir: iade yapilmis olabilir, cagiran yeniden DENEMEZ.
   */
  abstract refundPayment(input: RefundPaymentInput): Promise<RefundOutcome>;
}

export interface RefundPaymentInput {
  /** Bizim RefundPayout.id'miz; Iyzico'da conversationId olarak gider. */
  payoutId: string;
  paymentTransactionId: string;
  amountKurus: number;
}

export type RefundOutcome =
  { kind: 'REFUNDED'; providerRef: string } | { kind: 'REJECTED'; reason: string };

export interface ReversePaymentInput {
  topUpId: string;
  paymentId: string;
  paymentTransactionId: string | null;
  amountKurus: number;
}

export class PaymentProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}
