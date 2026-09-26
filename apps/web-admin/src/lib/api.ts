import type { AuthResponse, Me } from '@qwash/contracts';

// API istemcisi: yanit zarfi, access token (yalniz bellekte) ve refresh yonetimi.
// Refresh token HTTP-only cookie'dedir (SECURITY.md 1.1); JS onu goremez.

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1').replace(
  /\/$/,
  '',
);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ---------------------------------------------------------------------------
// Oturum durumu (useSyncExternalStore ile okunur)
// ---------------------------------------------------------------------------

export type AuthState =
  { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; user: Me };

let state: AuthState = { status: 'loading' };
let accessToken: string | null = null;
let accessExpiresAt = 0;
const listeners = new Set<() => void>();

export function getAuthState(): AuthState {
  return state;
}

export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setState(next: AuthState): void {
  state = next;
  listeners.forEach((l) => l());
}

/** Giris/kayit/refresh yanitini uygular. */
export function applyAuth(res: AuthResponse): void {
  accessToken = res.accessToken;
  accessExpiresAt = Date.parse(res.accessTokenExpiresAt);
  setState({ status: 'authenticated', user: res.user });
}

export function updateUser(user: Me): void {
  if (state.status === 'authenticated') setState({ status: 'authenticated', user });
}

export function clearAuth(): void {
  accessToken = null;
  accessExpiresAt = 0;
  setState({ status: 'anonymous' });
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

let refreshing: Promise<boolean> | null = null;

/**
 * Refresh token'i dondurup yeni access token alir. Ayni sekmede tek istek (single-flight).
 * Sekmeler arasi Web Locks ile siralanir: backend kullanilmis refresh token'in tekrar
 * gelmesini calinma sayar ve tum oturumlari kapatir (ADR-0009). Iki sekme ayni anda
 * ayni cookie ile refresh yaparsa kullanici disari atilirdi. Kilidi alan ikinci sekme
 * ilkinin yazdigi yeni cookie'yi gonderir.
 */
export function refreshSession(): Promise<boolean> {
  refreshing ??= withCrossTabLock(doRefresh).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function doRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) {
      clearAuth();
      return false;
    }
    const body = (await res.json()) as { data: AuthResponse };
    applyAuth(body.data);
    return true;
  } catch {
    // Ag hatasi: oturumu silme; bir sonraki istekte tekrar denenir.
    if (state.status === 'loading') setState({ status: 'anonymous' });
    return false;
  }
}

function withCrossTabLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? locks.request('qwash-auth-refresh', fn) : fn();
}

/** Suresi dolmak uzere olan token'i once yeniler. Soket baglantisi da bunu kullanir. */
export async function getFreshAccessToken(): Promise<string | null> {
  if (accessToken && accessExpiresAt - Date.now() > 30_000) return accessToken;
  if (state.status === 'anonymous') return null;
  await refreshSession();
  return accessToken;
}

// ---------------------------------------------------------------------------
// Istek
// ---------------------------------------------------------------------------

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  /** false: Authorization gonderilmez (girissiz uclar). */
  auth?: boolean;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const auth = options.auth ?? true;
  const send = async (token: string | null) => {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    try {
      return await fetch(`${API_URL}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: 'include',
      });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', 'Sunucuya ulasilamadi. Baglantinizi kontrol edin.');
    }
  };

  let res = await send(auth ? await getFreshAccessToken() : null);
  // Token sunucuda gecersiz sayildiysa (or. saat farki) bir kez yenileyip tekrar dene.
  if (res.status === 401 && auth && (await refreshSession())) {
    res = await send(accessToken);
  }
  return unwrap<T>(res);
}

async function unwrap<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(res.status, 'BAD_RESPONSE', 'Beklenmeyen bir sunucu yaniti alindi.');
  }
  const envelope = body as {
    success?: boolean;
    data?: T;
    error?: { code: string; message: string; details?: unknown };
  };
  if (res.ok && envelope.success) return envelope.data as T;
  const err = envelope.error;
  throw new ApiError(
    res.status,
    err?.code ?? 'HTTP_ERROR',
    err?.message ?? 'Islem tamamlanamadi.',
    err?.details,
  );
}

/** Tarayicida guvenli rastgele anahtar (Idempotency-Key). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
