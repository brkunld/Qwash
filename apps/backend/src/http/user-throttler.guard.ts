import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { AuthService } from '../auth/auth.service';

/**
 * Hiz siniri girisli istekte kullanici basina, girissizde IP basina sayilir (API.md 6).
 * Istasyondaki musteriler mobil operator NAT'i arkasinda ayni IP'yi paylasabilir;
 * IP basina sinir birinin denemesini digerine yazardi.
 *
 * Kullanici kovasi yalniz IMZASI DOGRULANAN token'a verilir. Onceki surum token'in
 * ozetini dogrulamadan kullaniyordu: her istege uydurma bir `Bearer` basligi eklenerek
 * her seferinde yeni kova aliniyor, giris ucundaki kaba kuvvet siniri atlatiliyordu
 * (guvenlik gozden gecirmesi, 2026-09-26). Gecersiz token IP kovasina duser.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly auth: AuthService,
  ) {
    super(options, storage, reflector);
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const header = (req.headers as Record<string, unknown> | undefined)?.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      try {
        const { userId } = await this.auth.verifyAccessToken(header.slice(7).trim());
        return `user:${userId}`;
      } catch {
        // Gecersiz/suresi dolmus token: IP'ye sayilir.
      }
    }
    return super.getTracker(req);
  }
}
