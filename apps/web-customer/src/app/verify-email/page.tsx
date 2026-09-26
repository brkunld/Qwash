'use client';

import type { Me } from '@qwash/contracts';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Alert, LinkButton, Loading, Page } from '@/components/ui';
import { api, getAuthState, updateUser } from '@/lib/api';
import { errorMessage } from '@/lib/errors';

function Verify() {
  const token = useSearchParams().get('token');
  const [result, setResult] = useState<'pending' | 'ok' | string>('pending');
  // Token tek kullanimlik: StrictMode'daki cift effect ikinci istegi "kullanilmis" yapardi.
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current || !token) return;
    sent.current = true;
    api<void>('/auth/verify-email', { method: 'POST', body: { token }, auth: false })
      .then(async () => {
        setResult('ok');
        if (getAuthState().status === 'authenticated') updateUser(await api<Me>('/me'));
      })
      .catch((err: unknown) => setResult(errorMessage(err)));
  }, [token]);

  if (!token) return <Alert>Doğrulama bağlantısı eksik.</Alert>;
  if (result === 'pending') return <Loading label="E-posta doğrulanıyor…" />;
  return (
    <div className="flex flex-col gap-4">
      {result === 'ok' ? (
        <Alert tone="success">E-posta adresiniz doğrulandı. Artık bakiye yükleyebilirsiniz.</Alert>
      ) : (
        <Alert>{result}</Alert>
      )}
      <LinkButton href="/">Ana sayfa</LinkButton>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Page title="E-posta doğrulama">
      <Suspense fallback={<Loading />}>
        <Verify />
      </Suspense>
    </Page>
  );
}
