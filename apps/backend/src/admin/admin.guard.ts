import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { UnauthenticatedError } from '../auth/auth.errors';
import { AccessClaims, AuthService } from '../auth/auth.service';
import { UserRole, UserStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { AdminForbiddenError } from './admin.errors';

export interface AdminActor {
  userId: string;
  role: 'ADMIN' | 'SUPER_ADMIN';
}

type AdminRequest = Request & { auth?: AccessClaims; admin?: AdminActor };

const SUPER_ONLY = 'qwash:superAdminOnly';

/** Yalniz SUPER_ADMIN (yukleme ayarlari, tarife, rol verme). */
export const SuperAdminOnly = () => SetMetadata(SUPER_ONLY, true);

/**
 * Admin uclarinin koruyucusu (ADR-0011 madde 1).
 *
 * Access token'daki `role` claim'ine guvenilmez: token 15 dk gecerli, yetkisi alinan
 * veya askiya alinan admin bu surede islem yapamamali. Rol ve durum her istekte
 * veritabanindan okunur.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthenticatedError();
    const claims = await this.auth.verifyAccessToken(header.slice('Bearer '.length).trim());

    const user = await this.prisma.user.findUnique({
      where: { id: claims.userId },
      select: { role: true, status: true },
    });
    if (!user || user.status !== UserStatus.ACTIVE) throw new UnauthenticatedError();
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.SUPER_ADMIN) {
      throw new AdminForbiddenError();
    }

    const superOnly = this.reflector.getAllAndOverride<boolean>(SUPER_ONLY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (superOnly && user.role !== UserRole.SUPER_ADMIN) throw new AdminForbiddenError();

    req.auth = claims;
    req.admin = { userId: claims.userId, role: user.role };
    return true;
  }
}

export function adminFromRequest(req: Request): AdminActor {
  const admin = (req as AdminRequest).admin;
  if (!admin) throw new UnauthenticatedError();
  return admin;
}
