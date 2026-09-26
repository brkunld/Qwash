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
      const next = pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [auth.status, pathname, router]);
  return auth;
}

/**
 * Giris sonrasi donulecek adres. Yalniz uygulama ici yol kabul edilir: "//site" veya
 * "https://..." gibi degerler baska siteye yonlendirme (open redirect) icin kullanilabilir.
 */
export function safeNext(raw: string | null, fallback = '/'): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return fallback;
  return raw;
}

export async function login(email: string, password: string): Promise<void> {
  applyAuth(
    await api<AuthResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    }),
  );
}

export async function register(fullName: string, email: string, password: string): Promise<void> {
  applyAuth(
    await api<AuthResponse>('/auth/register', {
      method: 'POST',
      body: { fullName, email, password },
      auth: false,
    }),
  );
}

export async function logout(): Promise<void> {
  try {
    await api<void>('/auth/logout', { method: 'POST', auth: false });
  } finally {
    clearAuth();
  }
}
