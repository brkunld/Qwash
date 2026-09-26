import {
  CheckoutOutcome,
  InitializeCheckoutInput,
  InitializedCheckout,
  PaymentGateway,
  PaymentProviderError,
  RefundOutcome,
  RefundPaymentInput,
  ReversePaymentInput,
} from '../src/payments/payment-gateway';

/** Testlerde Iyzico yerine: her token icin sonuc elle belirlenir. */
export class FakePaymentGateway extends PaymentGateway {
  readonly initialized: InitializeCheckoutInput[] = [];
  readonly outcomes = new Map<string, CheckoutOutcome | Error>();
  failInitialize = false;
  retrieveCalls = 0;
  webhookSecret = 'dogru-imza';

  initializeCheckout(input: InitializeCheckoutInput): Promise<InitializedCheckout> {
    if (this.failInitialize) return Promise.reject(new PaymentProviderError('Iyzico kapali'));
    this.initialized.push(input);
    const token = `tok-${input.topUpId}`;
    return Promise.resolve({ token, paymentPageUrl: `https://pay.test/${token}` });
  }

  async retrieveCheckout(token: string): Promise<CheckoutOutcome> {
    this.retrieveCalls += 1;
    // Gercek ag gecikmesi: eszamanli cagrilar ic ice gecsin.
    await new Promise((r) => setTimeout(r, 5));
    const outcome = this.outcomes.get(token) ?? { kind: 'PENDING', reason: 'form acik' };
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }

  verifyWebhook(_body: unknown, signature: string | undefined): boolean {
    return signature === this.webhookSecret;
  }

  readonly reversed: ReversePaymentInput[] = [];
  failReverse = false;

  reversePayment(input: ReversePaymentInput): Promise<'CANCELLED' | 'REFUNDED'> {
    if (this.failReverse) return Promise.reject(new PaymentProviderError('Iyzico iade kapali'));
    this.reversed.push(input);
    return Promise.resolve('CANCELLED');
  }

  readonly refunds: RefundPaymentInput[] = [];
  /** 'REJECT': Iyzico reddeder; 'TIMEOUT': istek gitti ama cevap gelmedi (belirsiz). */
  refundMode: 'OK' | 'REJECT' | 'TIMEOUT' = 'OK';

  refundPayment(input: RefundPaymentInput): Promise<RefundOutcome> {
    this.refunds.push(input);
    if (this.refundMode === 'TIMEOUT') {
      return Promise.reject(new PaymentProviderError('zaman asimi'));
    }
    if (this.refundMode === 'REJECT') {
      return Promise.resolve({ kind: 'REJECTED', reason: '10093 iade suresi gecmis' });
    }
    return Promise.resolve({ kind: 'REFUNDED', providerRef: `rf-${input.payoutId}` });
  }

  /** topUpId icin basarili odeme sonucu kurar. */
  succeed(
    topUpId: string,
    amountKurus: number,
    overrides: Partial<Extract<CheckoutOutcome, { kind: 'SUCCESS' }>> = {},
  ): string {
    const token = `tok-${topUpId}`;
    this.outcomes.set(token, {
      kind: 'SUCCESS',
      paymentId: `pay-${topUpId}`,
      paymentTransactionId: `ptx-${topUpId}`,
      paidKurus: amountKurus,
      currency: 'TRY',
      basketId: topUpId,
      conversationId: topUpId,
      ...overrides,
    });
    return token;
  }
}
