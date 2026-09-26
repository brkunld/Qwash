'use client';

import type { SessionView, WalletView } from '@qwash/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Card, LinkButton, Loading, Page } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { tl } from '@/lib/format';

export default function HomePage() {
  const auth = useAuth();
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [active, setActive] = useState<SessionView | null>(null);

  useEffect(() => {
    if (auth.status !== 'authenticated') return;
    api<WalletView>('/wallet')
      .then(setWallet)
      .catch(() => undefined);
    // Arka plandan donen PWA: suren yikama varsa gosterilir (ADR-0008).
    api<SessionView | null>('/sessions/active')
      .then(setActive)
      .catch(() => undefined);
  }, [auth.status]);

  return (
    <Page>
      {active && (
        <Alert tone="info">
          {active.bayName} peronunda süren bir yıkamanız var.{' '}
          <Link href={`/session/${active.sessionId}`} className="font-semibold underline">
            Yıkamaya dön
          </Link>
        </Alert>
      )}

      <Card className="text-center">
        <h1 className="text-2xl font-bold">Yıkamaya başlamak için</h1>
        <p className="mt-2 text-slate-600">
          Peron ekranındaki QR kodu telefonunuzun kamerasıyla okutun.
        </p>
      </Card>

      {auth.status === 'loading' && <Loading />}
      {auth.status === 'anonymous' && (
        <>
          <LinkButton href="/login">Giriş yap</LinkButton>
          <LinkButton href="/register" variant="secondary">
            Hesap oluştur
          </LinkButton>
        </>
      )}
      {auth.status === 'authenticated' && (
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-500">Bakiye</p>
              <p className="text-2xl font-bold">{wallet ? tl(wallet.availableKurus) : '…'}</p>
            </div>
            <Link
              href="/wallet"
              className="rounded-xl bg-sky-600 px-4 py-3 font-semibold text-white hover:bg-sky-700"
            >
              Yükle
            </Link>
          </div>
        </Card>
      )}
    </Page>
  );
}
