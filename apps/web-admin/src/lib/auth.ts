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

/** Yalniz uygulama ici yol kabul edilir (open redirect savunmasi). */
export function safeNext(raw: string | null, fallback = '/'): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return fallback;
  return raw;
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
