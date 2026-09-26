import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { kurusToPrice, priceToKurus, signaturePrice } from './money-format';
import {
  CheckoutOutcome,
  InitializeCheckoutInput,
  InitializedCheckout,
  PaymentGateway,
  PaymentProviderError,
  ReversePaymentInput,
} from './payment-gateway';

// Iyzico REST istemcisi (Checkout Form). Resmi SDK yerine dogrudan REST: bagimlilik yok,
// imza ve tutar bicimi burada acikca test edilebilir.
// Kaynaklar (2026-09-26):
//   https://docs.iyzico.com/en/payment-methods/checkoutform/cf-implementation/cf-initialize
//   https://docs.iyzico.com/en/advanced/response-signature-validation
//   https://docs.iyzico.com/en/advanced/webhook

const INITIALIZE_PATH = '/payment/iyzipos/checkoutform/initialize/auth/ecom';
const RETRIEVE_PATH = '/payment/iyzipos/checkoutform/auth/ecom/detail';
// https://docs.iyzico.com/en/advanced/refund-and-cancel
const CANCEL_PATH = '/payment/cancel';
const REFUND_PATH = '/payment/refund';
const REQUEST_TIMEOUT_MS = 15_000;

// Iyzico alici icin TC kimlik no, adres ve sehir ister. Bakiye yuklemesinde fatura/kargo
// olmadigi icin yer tutucu gonderilir. Sandbox'ta ve Iyzico/muhasebeciyle teyit edilmeli
// (ROADMAP Faz 5: "Iyzico zorunlu alici alanlari").
const PLACEHOLDER_IDENTITY_NUMBER = '11111111111';
const PLACEHOLDER_CITY = 'Istanbul';
const PLACEHOLDER_COUNTRY = 'Turkey';
const PLACEHOLDER_ADDRESS = 'Qwash self servis yikama istasyonu';

export interface IyzicoOptions {
  apiKey: string;
  secretKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

export class IyzicoGateway extends PaymentGateway {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: IyzicoOptions) {
    super();
    this.fetchImpl = options.fetch ?? fetch;
  }

  async initializeCheckout(input: InitializeCheckoutInput): Promise<InitializedCheckout> {
    const price = kurusToPrice(input.amountKurus);
    const { name, surname } = splitName(input.buyer.fullName);
    const contactName = `${name} ${surname}`;
    const body = {
      locale: 'tr',
      conversationId: input.topUpId,
      price,
      paidPrice: price,
      currency: 'TRY',
      basketId: input.topUpId,
      paymentGroup: 'PRODUCT',
      callbackUrl: input.callbackUrl,
      enabledInstallments: [1],
      buyer: {
        id: input.buyer.id,
        name,
        surname,
        email: input.buyer.email,
        identityNumber: PLACEHOLDER_IDENTITY_NUMBER,
        ...(input.buyer.phoneNumber ? { gsmNumber: input.buyer.phoneNumber } : {}),
        registrationAddress: PLACEHOLDER_ADDRESS,
        city: PLACEHOLDER_CITY,
        country: PLACEHOLDER_COUNTRY,
        ...(buyerIp(input.buyer.ip) ? { ip: buyerIp(input.buyer.ip) } : {}),
      },
      billingAddress: {
        contactName,
        city: PLACEHOLDER_CITY,
        country: PLACEHOLDER_COUNTRY,
        address: PLACEHOLDER_ADDRESS,
      },
      basketItems: [
        {
          id: input.topUpId,
          name: 'Qwash bakiye yukleme',
          category1: 'Bakiye',
          itemType: 'VIRTUAL',
          price,
        },
      ],
    };

    const res = await this.post(INITIALIZE_PATH, body);
    if (res.status !== 'success') {
      throw new PaymentProviderError(`Iyzico formu acilamadi: ${describeError(res)}`);
    }
    const token = str(res.token);
    const paymentPageUrl = str(res.paymentPageUrl);
    if (!token || !paymentPageUrl) throw new PaymentProviderError('Iyzico yaniti eksik (token)');
    this.assertSignature(res, [str(res.conversationId), token]);
    return { token, paymentPageUrl };
  }

  async retrieveCheckout(token: string): Promise<CheckoutOutcome> {
    const res = await this.post(RETRIEVE_PATH, { locale: 'tr', token });
    if (res.status !== 'success') {
      // Istek duzeyinde hata: form henuz tamamlanmamis olabilir; kesin sonuc sayilmaz.
      return { kind: 'PENDING', reason: describeError(res) };
    }

    const paymentStatus = str(res.paymentStatus);
    if (paymentStatus !== 'SUCCESS') {
      return paymentStatus === 'FAILURE'
        ? { kind: 'FAILURE', reason: describeFailure(res) }
        : { kind: 'PENDING', reason: `paymentStatus=${paymentStatus ?? '-'}` };
    }

    this.assertSignature(res, [
      paymentStatus,
      str(res.paymentId),
      str(res.currency),
      str(res.basketId),
      str(res.conversationId),
      signaturePrice(num(res.paidPrice)),
      signaturePrice(num(res.price)),
      str(res.token),
    ]);

    // fraudStatus: 1 onay, 0 inceleme, -1 red.
    const fraudStatus = Number(res.fraudStatus);
    if (fraudStatus === 0) return { kind: 'PENDING', reason: 'fraud incelemesi' };
    if (fraudStatus !== 1)
      return { kind: 'FAILURE', reason: `fraudStatus=${String(res.fraudStatus)}` };

    const items = Array.isArray(res.itemTransactions) ? (res.itemTransactions as Json[]) : [];
    return {
      kind: 'SUCCESS',
      paymentId: str(res.paymentId) ?? '',
      paymentTransactionId: str(items[0]?.paymentTransactionId) ?? null,
      paidKurus: priceToKurus(num(res.paidPrice)),
      currency: str(res.currency) ?? '',
      basketId: str(res.basketId) ?? '',
      conversationId: str(res.conversationId) ?? null,
    };
  }

  async reversePayment(input: ReversePaymentInput): Promise<'CANCELLED' | 'REFUNDED'> {
    // Iptal yalniz odeme gunu mumkun ve ekstrede iz birakmaz; olmazsa iade.
    const cancel = await this.post(CANCEL_PATH, {
      locale: 'tr',
      conversationId: input.topUpId,
      paymentId: input.paymentId,
    });
    if (cancel.status === 'success') return 'CANCELLED';

    if (!input.paymentTransactionId) {
      throw new PaymentProviderError(
        `Iyzico iptal edilemedi, iade kimligi yok: ${describeError(cancel)}`,
      );
    }
    const refund = await this.post(REFUND_PATH, {
      locale: 'tr',
      conversationId: input.topUpId,
      paymentTransactionId: input.paymentTransactionId,
      price: kurusToPrice(input.amountKurus),
      currency: 'TRY',
    });
    if (refund.status === 'success') return 'REFUNDED';
    throw new PaymentProviderError(
      `Iyzico iptal/iade basarisiz: iptal=${describeError(cancel)}; iade=${describeError(refund)}`,
    );
  }

  /** V3: HMAC-SHA256(secretKey, secretKey + iyziEventType + iyziPaymentId + token + paymentConversationId + status), hex. */
  verifyWebhook(body: unknown, signature: string | undefined): boolean {
    if (!signature || typeof body !== 'object' || body === null) return false;
    const b = body as Json;
    const parts = [b.iyziEventType, b.iyziPaymentId, b.token, b.paymentConversationId, b.status];
    if (parts.some((p) => p === undefined || p === null)) return false;
    const payload = this.options.secretKey + parts.map((p) => String(p)).join('');
    const expected = createHmac('sha256', this.options.secretKey).update(payload).digest('hex');
    return safeEqualHex(expected, signature);
  }

  private assertSignature(res: Json, fields: (string | undefined)[]): void {
    const signature = str(res.signature);
    if (!signature) throw new PaymentProviderError('Iyzico yanitinda imza yok');
    const expected = createHmac('sha256', this.options.secretKey)
      .update(fields.map((f) => f ?? '').join(':'))
      .digest('hex');
    if (!safeEqualHex(expected, signature)) {
      throw new PaymentProviderError('Iyzico yanit imzasi dogrulanamadi');
    }
  }

  private async post(path: string, body: Json): Promise<Json> {
    const json = JSON.stringify(body);
    const randomKey = `${Date.now()}${randomBytes(8).toString('hex')}`;
    const signature = createHmac('sha256', this.options.secretKey)
      .update(randomKey + path + json)
      .digest('hex');
    const authorization = Buffer.from(
      `apiKey:${this.options.apiKey}&randomKey:${randomKey}&signature:${signature}`,
    ).toString('base64');

    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.options.baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `IYZWSv2 ${authorization}`,
          'x-iyzi-rnd': randomKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: json,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new PaymentProviderError(`Iyzico'ya ulasilamadi: ${(error as Error).message}`);
    }
    try {
      return (await response.json()) as Json;
    } catch {
      throw new PaymentProviderError(`Iyzico gecersiz yanit dondu (HTTP ${response.status})`);
    }
  }
}

/** "::ffff:1.2.3.4" -> "1.2.3.4"; yerel/loopback adres Iyzico'ya gonderilmez. */
export function buyerIp(ip: string | null): string | null {
  if (!ip) return null;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (v4 === '::1' || v4.startsWith('127.') || v4 === 'localhost') return null;
  return v4;
}

function splitName(fullName: string | null): { name: string; surname: string } {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return { name: parts.slice(0, -1).join(' '), surname: parts.at(-1)! };
  if (parts.length === 1) return { name: parts[0]!, surname: '-' };
  return { name: 'Qwash', surname: 'Musteri' };
}

/**
 * Basarisiz odemede Iyzico cogu zaman errorMessage vermez; 3DS sonucu mdStatus'tadir
 * (sandbox'ta goruldu, 2026-09-26: mdStatus 0, mesaj yok). 1 = 3DS basarili.
 */
function describeFailure(res: Json): string {
  if (str(res.errorMessage) || str(res.errorCode)) return describeError(res);
  const mdStatus = str(res.mdStatus);
  if (mdStatus !== undefined && mdStatus !== '1') {
    return `3D Secure dogrulamasi basarisiz (mdStatus=${mdStatus})`;
  }
  return 'Odeme banka tarafindan reddedildi';
}

function describeError(res: Json): string {
  const code = str(res.errorCode);
  const message = str(res.errorMessage);
  return [code, message].filter(Boolean).join(' ') || 'bilinmeyen hata';
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function num(value: unknown): string | number {
  if (typeof value === 'number' || typeof value === 'string') return value;
  throw new PaymentProviderError('Iyzico yanitinda tutar yok');
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b.toLowerCase(), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
