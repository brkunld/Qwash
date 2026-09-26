import type { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { ApiErrorFilter } from './api-envelope';

function run(exception: unknown) {
  const headers: Record<string, string> = {};
  let status = 0;
  let body: unknown;
  const res = {
    setHeader: (k: string, v: string) => (headers[k] = v),
    status: (s: number) => {
      status = s;
      return res;
    },
    json: (b: unknown) => (body = b),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'POST', url: '/api/v1/sessions', id: 'req-1' }),
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;
  new ApiErrorFilter().catch(exception, host);
  return { status, headers, body };
}

describe('ApiErrorFilter', () => {
  it('islem baslatilamadi (P2028) -> 503 SERVICE_BUSY + Retry-After', () => {
    const error = new Prisma.PrismaClientKnownRequestError('Unable to start a transaction', {
      code: 'P2028',
      clientVersion: 'test',
    });
    const { status, headers, body } = run(error);
    expect(status).toBe(503);
    expect(headers['Retry-After']).toBe('1');
    expect(body).toMatchObject({ success: false, error: { code: 'SERVICE_BUSY' } });
  });

  it('bilinmeyen hata 500 INTERNAL_ERROR kalir', () => {
    const { status, body } = run(new Error('boom'));
    expect(status).toBe(500);
    expect(body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });
});
