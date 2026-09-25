import { createHmac } from 'node:crypto';
import { IyzicoGateway } from './iyzico.gateway';
import { PaymentProviderError } from './payment-gateway';

const SECRET = 'sandbox-secret';
const hmac = (data: string) => createHmac('sha256', SECRET).update(data).digest('hex');

function gatewayReturning(response: Record<string, unknown>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: URL, init: RequestInit) => {
    calls.push({ url: url.toString(), init });
    return Promise.resolve(new Response(JSON.stringify(response)));
  }) as unknown as typeof fetch;
  const gateway = new IyzicoGateway({
    apiKey: 'sandbox-api',
    secretKey: SECRET,
    baseUrl: 'https://sandbox-api.iyzipay.com',
    fetch: fetchImpl,
  });
  return { gateway, calls };
}

function successDetail(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    status: 'success',
    paymentStatus: 'SUCCESS',
    fraudStatus: 1,
    paymentId: '2233',
    currency: 'TRY',
    basketId: 'topup-1',
    conversationId: 'topup-1',
    paidPrice: 50.0,
    price: 50.0,
    token: 'tok-1',
    itemTransactions: [{ paymentTransactionId: 'ptx-9' }],
    ...overrides,
  };
  base.signature ??= hmac(
    [
      'SUCCESS',
      base.paymentId,
      base.currency,
      base.basketId,
      base.conversationId,
      '50',
      '50',
      base.token,
    ].join(':'),
  );
  return base;
}

describe('IyzicoGateway', () => {
  it('istegi IYZWSv2 ile imzalar ve formu baslatir', async () => {
    const { gateway, calls } = gatewayReturning({
      status: 'success',
      conversationId: 'topup-1',
      token: 'tok-1',
      paymentPageUrl: 'https://sandbox-cpp.iyzipay.com?token=tok-1',
      signature: hmac('topup-1:tok-1'),
    });

    const result = await gateway.initializeCheckout({
      topUpId: 'topup-1',
      amountKurus: 5050,
      callbackUrl: 'http://api.test/cb',
      buyer: {
        id: 'u1',
        fullName: 'Ali Veli Can',
        email: 'a@b.c',
        phoneNumber: null,
        ip: '1.2.3.4',
      },
    });

    expect(result).toEqual({
      token: 'tok-1',
      paymentPageUrl: 'https://sandbox-cpp.iyzipay.com?token=tok-1',
    });
    const call = calls[0]!;
    expect(call.url).toBe(
      'https://sandbox-api.iyzipay.com/payment/iyzipos/checkoutform/initialize/auth/ecom',
    );
    const headers = call.init.headers as Record<string, string>;
    const rnd = headers['x-iyzi-rnd']!;
    const decoded = Buffer.from(
      headers.Authorization!.replace('IYZWSv2 ', ''),
      'base64',
    ).toString();
    const expectedSig = hmac(
      rnd + '/payment/iyzipos/checkoutform/initialize/auth/ecom' + String(call.init.body),
    );
    expect(decoded).toBe(`apiKey:sandbox-api&randomKey:${rnd}&signature:${expectedSig}`);

    const body = JSON.parse(String(call.init.body)) as {
      buyer: Record<string, unknown>;
      basketItems: Record<string, unknown>[];
    };
    expect(body).toMatchObject({
      price: '50.5',
      paidPrice: '50.5',
      basketId: 'topup-1',
      enabledInstallments: [1],
    });
    expect(body.buyer).toMatchObject({ name: 'Ali Veli', surname: 'Can', ip: '1.2.3.4' });
    expect(body.basketItems[0]).toMatchObject({ itemType: 'VIRTUAL', price: '50.5' });
  });

  it('baslatma yanitinin imzasi tutmazsa hata verir', async () => {
    const { gateway } = gatewayReturning({
      status: 'success',
      conversationId: 'topup-1',
      token: 'tok-1',
      paymentPageUrl: 'x',
      signature: 'bozuk',
    });
    await expect(
      gateway.initializeCheckout({
        topUpId: 'topup-1',
        amountKurus: 5000,
        callbackUrl: 'http://api.test/cb',
        buyer: { id: 'u1', fullName: null, email: 'a@b.c', phoneNumber: null, ip: null },
      }),
    ).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('basarili odemeyi imzasiyla dogrular ve kurusa cevirir', async () => {
    const { gateway } = gatewayReturning(successDetail());
    await expect(gateway.retrieveCheckout('tok-1')).resolves.toEqual({
      kind: 'SUCCESS',
      paymentId: '2233',
      paymentTransactionId: 'ptx-9',
      paidKurus: 5000,
      currency: 'TRY',
      basketId: 'topup-1',
      conversationId: 'topup-1',
    });
  });

  it('imzasi tutmayan basari yaniti reddedilir (bakiye yuklenemez)', async () => {
    const { gateway } = gatewayReturning(successDetail({ signature: hmac('sahte') }));
    await expect(gateway.retrieveCheckout('tok-1')).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('fraud incelemesi bekler, fraud reddi basarisizdir', async () => {
    await expect(
      gatewayReturning(successDetail({ fraudStatus: 0 })).gateway.retrieveCheckout('tok-1'),
    ).resolves.toMatchObject({ kind: 'PENDING' });
    await expect(
      gatewayReturning(successDetail({ fraudStatus: -1 })).gateway.retrieveCheckout('tok-1'),
    ).resolves.toMatchObject({ kind: 'FAILURE' });
  });

  it('odeme FAILURE ise basarisiz, istek hatasi ise beklemede sayilir', async () => {
    await expect(
      gatewayReturning({
        status: 'success',
        paymentStatus: 'FAILURE',
        errorMessage: 'Kart reddedildi',
      }).gateway.retrieveCheckout('t'),
    ).resolves.toEqual({ kind: 'FAILURE', reason: 'Kart reddedildi' });
    await expect(
      gatewayReturning({
        status: 'failure',
        errorCode: '5',
        errorMessage: 'token bulunamadi',
      }).gateway.retrieveCheckout('t'),
    ).resolves.toMatchObject({ kind: 'PENDING' });
  });

  it('odemeyi once iptal etmeyi dener; iptal olmazsa tam iade yapar', async () => {
    const input = {
      topUpId: 't1',
      paymentId: 'p1',
      paymentTransactionId: 'ptx1',
      amountKurus: 5050,
    };
    await expect(
      gatewayReturning({ status: 'success' }).gateway.reversePayment(input),
    ).resolves.toBe('CANCELLED');

    const responses = [
      { status: 'failure', errorMessage: 'gun sonu gecti' },
      { status: 'success' },
    ];
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const gateway = new IyzicoGateway({
      apiKey: 'k',
      secretKey: SECRET,
      baseUrl: 'https://sandbox-api.iyzipay.com',
      fetch: ((url: URL, init: RequestInit) => {
        calls.push({
          url: url.toString(),
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        return Promise.resolve(new Response(JSON.stringify(responses.shift())));
      }) as unknown as typeof fetch,
    });
    await expect(gateway.reversePayment(input)).resolves.toBe('REFUNDED');
    expect(calls.map((c) => c.url)).toEqual([
      'https://sandbox-api.iyzipay.com/payment/cancel',
      'https://sandbox-api.iyzipay.com/payment/refund',
    ]);
    expect(calls[1]?.body).toMatchObject({
      paymentTransactionId: 'ptx1',
      price: '50.5',
      currency: 'TRY',
    });
  });

  it('iptal ve iade ikisi de basarisizsa hata verir', async () => {
    const { gateway } = gatewayReturning({ status: 'failure', errorMessage: 'hata' });
    await expect(
      gateway.reversePayment({
        topUpId: 't',
        paymentId: 'p',
        paymentTransactionId: 'x',
        amountKurus: 100,
      }),
    ).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('webhook V3 imzasini dogrular', () => {
    const { gateway } = gatewayReturning({});
    const body = {
      iyziEventType: 'CHECKOUT_FORM_AUTH',
      iyziPaymentId: 2233,
      token: 'tok-1',
      paymentConversationId: 'topup-1',
      status: 'SUCCESS',
    };
    const sig = hmac(`${SECRET}CHECKOUT_FORM_AUTH2233tok-1topup-1SUCCESS`);
    expect(gateway.verifyWebhook(body, sig)).toBe(true);
    expect(gateway.verifyWebhook(body, sig.toUpperCase())).toBe(true);
    expect(gateway.verifyWebhook({ ...body, status: 'FAILURE' }, sig)).toBe(false);
    expect(gateway.verifyWebhook(body, undefined)).toBe(false);
  });
});
