import { CanActivate, createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { UnauthenticatedError } from './auth.errors';
import { AccessClaims, AuthService } from './auth.service';

type AuthedRequest = Request & { auth?: AccessClaims };

/** Authorization: Bearer <access token> zorunlu kilar. */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthenticatedError();
    req.auth = await this.auth.verifyAccessToken(header.slice('Bearer '.length).trim());
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): AccessClaims => {
    const auth = context.switchToHttp().getRequest<AuthedRequest>().auth;
    if (!auth) throw new UnauthenticatedError();
    return auth;
  },
);
