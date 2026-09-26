'use client';

import type { Me, TopUpOptions, TopUpView, WalletView } from '@qwash/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, LinkButton, Loading, Page } from '@/components/ui';
import { api, newIdempotencyKey } from '@/lib/api';
import { safeNext, useRequireAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { tl } from '@/lib/format';
import { TOPUP_RETURN_KEY } from '@/lib/storage';

function Wallet({ me }: { me: Me }) {
  const next = useSearchParams().get('next');
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [options, setOptions] = useState<TopUpOptions | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Ayni tutar icin ayni anahtar: cift dokunma ikinci odeme sayfasi acmaz.
  const idemKey = useRef(newIdempotencyKey());

  useEffect(() => {
    api<WalletView>('/wallet').then(setWallet).catch(setError);
    api<TopUpOptions>('/payments/topup-options')
      .then((o) => {
        setOptions(o);
        setAmount((a) => a ?? o.presetsKurus[1] ?? o.presetsKurus[0] ?? null);
      })
      .catch(setError);
  }, []);

  useEffect(() => {
    idemKey.current = newIdempotencyKey();
  }, [amount]);

  async function topUp() {
    if (!amount) return;
    setBusy(true);
    setError(null);
    try {
      const t = await api<TopUpView>('/payments/topup', {
        method: 'POST',
        body: { amountKurus: amount },
        idempotencyKey: idemKey.current,
      });
      try {
        sessionStorage.setItem(TOPUP_RETURN_KEY, safeNext(next, '/'));
      } catch {
        // Gizli sekmede depolama kapali olabilir; donus ana sayfaya olur.
      }
      if (t.paymentPageUrl) window.location.assign(t.paymentPageUrl);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <>
      <Card className="text-center">
        <p className="text-sm text-slate-500">Kullanılabilir bakiye</p>
        <p className="mt-1 text-4xl font-extrabold">{wallet ? tl(wallet.availableKurus) : '…'}</p>
        {wallet && wallet.holdKurus > 0 && (
          <p className="mt-1 text-sm text-slate-500">
            {tl(wallet.holdKurus)} süren yıkama için ayrıldı
          </p>
        )}
      </Card>

      {!me.emailVerified ? (
        <Alert tone="warning">
          Kartla yüklemek için e-posta adresinizi doğrulayın. Doğrulama bağlantısını{' '}
          <Link href="/account" className="font-semibold underline">
            hesap sayfasından
          </Link>{' '}
          yeniden gönderebilirsiniz.
        </Alert>
      ) : (
        <Card>
          <h2 className="mb-3 font-semibold">Kartla yükle</h2>
          {options ? (
            <div className="grid grid-cols-3 gap-2">
              {options.presetsKurus.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setAmount(p)}
                  aria-pressed={p === amount}
                  className={`min-h-12 rounded-xl border font-semibold ${
                    p === amount
                      ? 'border-sky-600 bg-sky-600 text-white'
                      : 'border-slate-300 bg-white'
                  }`}
                >
                  {tl(p)}
                </button>
              ))}
            </div>
          ) : (
            <Loading />
          )}
          <p className="mt-3 text-xs text-slate-500">
            Ödeme Iyzico güvenli ödeme sayfasında yapılır; kart bilgileriniz QWASH&apos;a iletilmez.
            Yüklenen bakiye iade edilmez (teknik arıza ve hesap silme hariç).
          </p>
        </Card>
      )}

      {error !== null && <Alert>{errorMessage(error)}</Alert>}
      {me.emailVerified && (
        <Button onClick={topUp} busy={busy} disabled={!amount}>
          {amount ? `${tl(amount)} yükle` : 'Tutar seçin'}
        </Button>
      )}
      {next && (
        <LinkButton href={safeNext(next)} variant="secondary">
          Perona dön
        </LinkButton>
      )}
      <p className="text-center text-sm text-slate-500">Kasadan nakit yükleme de yapılabilir.</p>
    </>
  );
}

export default function WalletPage() {
  const auth = useRequireAuth();
  return (
    <Page title="Bakiye">
      {auth.status === 'authenticated' ? (
        <Suspense fallback={<Loading />}>
          <Wallet me={auth.user} />
        </Suspense>
      ) : (
        <Loading />
      )}
    </Page>
  );
}
