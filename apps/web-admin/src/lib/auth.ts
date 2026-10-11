'use client';

import type { AuthResponse } from '@qwash/contracts';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';
import {
  api,
  applyAuth,
  clearAuth,
  getAuthState,
  refreshSession,
  subscribeAuth,
  type AuthState,
} from './api';

const LOADING: AuthState = { status: 'loading' };

export function useAuth(): AuthState {
  return useSyncExternalStore(subscribeAuth, getAuthState, () => LOADING);
}

/** Sayfa acilisinda refresh cookie'si varsa oturumu geri yukler. */
export function useAuthBootstrap(): void {
  useEffect(() => {
    if (getAuthState().status === 'loading') void refreshSession();
  }, []);
}

/** Giris yoksa /login?next=<bu sayfa> adresine gonderir. */
export function useRequireAuth(): AuthState {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (auth.status === 'anonymous') {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [auth.status, pathname, router]);
  return auth;
}

const SAME_ORIGIN = 'http://qwash.invalid';

/**
 * Yalniz uygulama ici yol kabul edilir (open redirect savunmasi). Tarayici adresteki
 * sekme/satir sonunu siler ("/\t/evil.com" -> "//evil.com"); kontrol karakterleri reddedilir
 * ve deger URL olarak cozulup kaynagi karsilastirilir (web-customer ile ayni).
 */
export function safeNext(raw: string | null, fallback = '/'): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x1F\x7F]/.test(raw)) {
    return fallback;
  }
  try {
    const url = new URL(raw, SAME_ORIGIN);
    if (url.origin !== SAME_ORIGIN) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

/**
 * Yonetici girisi. Musteri girisiyle ayni uc; sunucu yetkiyi her istekte ayrica denetler,
 * buradaki rol kontrolu yalniz arayuzun yanlis hesapla acilmamasi icindir.
 */
export async function login(email: string, password: string): Promise<void> {
  const res = await api<AuthResponse>('/auth/login', {
    method: 'POST',
    body: { email, password },
    auth: false,
  });
  applyAuth(res);
}

export async function logout(): Promise<void> {
  try {
    await api<void>('/auth/logout', { method: 'POST', auth: false });
  } finally {
    clearAuth();
  }
}

export function isAdminRole(role: string): role is 'ADMIN' | 'SUPER_ADMIN' {
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}
