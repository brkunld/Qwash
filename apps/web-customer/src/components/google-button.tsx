'use client';

import type { AuthResponse } from '@qwash/contracts';
import { useEffect, useRef, useState } from 'react';
import { api, applyAuth } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { Alert } from './ui';

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

interface GoogleIdApi {
  initialize(config: {
    client_id: string;
    callback: (response: { credential?: string }) => void;
    ux_mode?: 'popup' | 'redirect';
    auto_select?: boolean;
  }): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdApi } };
  }
}

let scriptPromise: Promise<void> | null = null;

/** Google Identity Services betigini bir kez yukler. */
function loadScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = SCRIPT_SRC;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      scriptPromise = null; // Baglanti gelince yeniden denenebilsin.
      reject(new Error('Google betigi yuklenemedi'));
    };
    document.head.appendChild(el);
  });
  return scriptPromise;
}

/**
 * "Google ile devam et". Google'in verdigi ID token sunucuda dogrulanir (imza, aud, iss,
 * exp, email_verified); tarayicidaki JWT'ye guvenilmez. Client ID tanimli degilse bilesen
 * hicbir sey cizmez.
 */
export function GoogleButton({ onSuccess }: { onSuccess: () => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Google'in dugmesi bir kez cizilir; callback'in en guncel halini ref ile cagiririz.
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);

  useEffect(() => {
    if (!CLIENT_ID) return;
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !holder.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: CLIENT_ID,
          ux_mode: 'popup',
          callback: (response) => {
            if (!response.credential) return;
            setError(null);
            api<AuthResponse>('/auth/google', {
              method: 'POST',
              body: { idToken: response.credential },
              auth: false,
            })
              .then((res) => {
                applyAuth(res);
                onSuccessRef.current();
              })
              .catch((err: unknown) => setError(errorMessage(err)));
          },
        });
        window.google.accounts.id.renderButton(holder.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'pill',
          locale: 'tr',
          width: 320,
        });
      })
      .catch(() => {
        if (!cancelled) setError('Google ile giriş şu an kullanılamıyor.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!CLIENT_ID) return null;
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex w-full items-center gap-3 text-xs text-slate-500">
        <span className="h-px flex-1 bg-slate-200" />
        veya
        <span className="h-px flex-1 bg-slate-200" />
      </div>
      <div ref={holder} className="flex min-h-11 w-full justify-center" />
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
