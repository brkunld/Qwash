import {
  ArgumentsHost,
  CallHandler,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
  PipeTransform,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { map, Observable } from 'rxjs';
import { z } from 'zod';
import { AccountError } from '../account/account.errors';
import { AuthError } from '../auth/auth.errors';
import { PaymentError } from '../payments/payments.errors';

// API.md 2: tum yanitlar { success, data | error, metadata } zarfinda doner.

function metadata(req: Request): { correlationId: string; timestamp: string } {
  const id = (req as Request & { id?: unknown }).id;
  return {
    correlationId: typeof id === 'string' || typeof id === 'number' ? String(id) : '',
    timestamp: new Date().toISOString(),
  };
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    return next
      .handle()
      .pipe(
        map((data: unknown) =>
          res.statusCode === 204
            ? undefined
            : { success: true, data: data ?? null, metadata: metadata(req) },
        ),
      );
  }
}

const DOMAIN_STATUS: Record<string, HttpStatus> = {
  EMAIL_TAKEN: HttpStatus.CONFLICT,
  INVALID_CREDENTIALS: HttpStatus.UNAUTHORIZED,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  ACCOUNT_DISABLED: HttpStatus.FORBIDDEN,
  INVALID_TOKEN: HttpStatus.BAD_REQUEST,
  GOOGLE_LOGIN_DISABLED: HttpStatus.SERVICE_UNAVAILABLE,
  GOOGLE_EMAIL_NOT_VERIFIED: HttpStatus.FORBIDDEN,
  PAYMENTS_DISABLED: HttpStatus.SERVICE_UNAVAILABLE,
  EMAIL_NOT_VERIFIED: HttpStatus.FORBIDDEN,
  TOPUP_AMOUNT_OUT_OF_RANGE: HttpStatus.BAD_REQUEST,
  TOPUP_NOT_FOUND: HttpStatus.NOT_FOUND,
  IDEMPOTENCY_KEY_REQUIRED: HttpStatus.BAD_REQUEST,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  PAYMENT_PROVIDER_UNAVAILABLE: HttpStatus.BAD_GATEWAY,
  FULL_NAME_REQUIRED: HttpStatus.BAD_REQUEST,
  ACCOUNT_NOT_ACTIVE: HttpStatus.FORBIDDEN,
  NAME_LOCKED: HttpStatus.CONFLICT,
  ACTIVE_HOLD: HttpStatus.CONFLICT,
  TOPUP_IN_PROGRESS: HttpStatus.CONFLICT,
  BALANCE_DECISION_REQUIRED: HttpStatus.BAD_REQUEST,
  FORFEIT_CONFIRMATION_REQUIRED: HttpStatus.BAD_REQUEST,
  IBAN_REQUIRED: HttpStatus.BAD_REQUEST,
  PASSWORD_REQUIRED: HttpStatus.BAD_REQUEST,
  HOLDER_NAME_REQUIRED: HttpStatus.BAD_REQUEST,
};

export class ValidationError extends Error {
  constructor(readonly issues: z.core.$ZodIssue[]) {
    super('Istek gecersiz');
  }
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const req = host.switchToHttp().getRequest<Request>();
    const res = host.switchToHttp().getResponse<Response>();
    const { status, code, message, details } = this.describe(exception);
    if (status >= 500) this.logger.error(exception);
    res.status(status).json({
      success: false,
      error: { code, message, ...(details ? { details } : {}) },
      metadata: metadata(req),
    });
  }

  private describe(exception: unknown): {
    status: number;
    code: string;
    message: string;
    details?: unknown;
  } {
    if (
      exception instanceof AuthError ||
      exception instanceof PaymentError ||
      exception instanceof AccountError
    ) {
      return {
        status: DOMAIN_STATUS[exception.code] ?? HttpStatus.BAD_REQUEST,
        code: exception.code,
        message: exception.message,
        details: exception instanceof PaymentError ? exception.details : undefined,
      };
    }
    if (exception instanceof ValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'VALIDATION_FAILED',
        message: exception.issues[0]?.message ?? 'Istek gecersiz.',
        details: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    }
    if (exception instanceof ThrottlerException) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: 'RATE_LIMITED',
        message: 'Cok fazla deneme. Biraz sonra tekrar deneyin.',
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return { status, code: HttpStatus[status] ?? 'HTTP_ERROR', message: exception.message };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Beklenmeyen bir hata olustu.',
    };
  }
}

/** Istek govdesini bir Zod semasiyla dogrular ve donusturur. */
export class ZodBody<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) throw new ValidationError(result.error.issues);
    return result.data;
  }
}
