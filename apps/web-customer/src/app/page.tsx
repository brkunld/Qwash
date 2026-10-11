'use client';

import type { SessionView, WalletView } from '@qwash/contracts';
import { ArrowRightIcon, QrCodeIcon } from '@phosphor-icons/react';
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
        <Link
          href={`/session/${active.sessionId}`}
          className="flex items-center justify-between gap-3 rounded-[20px] border border-sky-200 bg-sky-50 p-4 text-sky-950 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-100"
        >
          <span className="text-sm">
            <span className="block font-semibold">Süren bir yıkamanız var</span>
            {active.bayName} peronu
          </span>
          <span className="inline-flex items-center gap-1 text-sm font-semibold">
            Yıkamaya dön <ArrowRightIcon aria-hidden className="size-4" />
          </span>
        </Link>
      )}

      <Card className="flex flex-col items-center gap-4 py-8 text-center">
        <span className="flex size-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
          <QrCodeIcon aria-hidden className="size-9" />
        </span>
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Yıkamaya başlamak için</h2>
          <p className="mx-auto mt-2 max-w-[34ch] text-ink-muted">
            Peron ekranındaki QR kodu telefonunuzun kamerasıyla okutun.
          </p>
        </div>
      </Card>

      {auth.status === 'loading' && <Loading />}
      {auth.status === 'anonymous' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <LinkButton href="/login">Giriş yap</LinkButton>
          <LinkButton href="/register" variant="secondary">
            Hesap oluştur
          </LinkButton>
        </div>
      )}
      {auth.status === 'authenticated' && (
        <Card>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-ink-muted">Kullanılabilir bakiye</p>
              <p className="tabular mt-0.5 text-3xl font-semibold tracking-tight">
                {wallet ? tl(wallet.availableKurus) : '…'}
              </p>
            </div>
            <Link
              href="/wallet"
              className="inline-flex min-h-12 items-center rounded-xl bg-brand-500 px-5 font-semibold text-[#15181d] transition-transform hover:bg-brand-600 active:scale-[0.98]"
            >
              Yükle
            </Link>
          </div>
        </Card>
      )}
    </Page>
  );
}
