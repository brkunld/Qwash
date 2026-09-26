'use client';

import type { TopUpView } from '@qwash/contracts';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, LinkButton, Loading, Page } from '@/components/ui';
import { api } from '@/lib/api';
import { safeNext, useRequireAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { tl } from '@/lib/format';
import { TOPUP_RETURN_KEY } from '@/lib/storage';

const POLL_MS = 2_000;
/** Sonuc gelmezse bu kadar beklenir; mutabakat arka planda tamamlar. */
const POLL_LIMIT_MS = 60_000;

const noopSubscribe = () => () => {};

function readReturnPath(): string {
  try {
    return safeNext(sessionStorage.getItem(TOPUP_RETURN_KEY), '/');
  } catch {
    return '/'; // depolama kapali (gizli sekme)
  }
}

function Result() {
  const id = useSearchParams().get('id');
  const [topUp, setTopUp] = useState<TopUpView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [gaveUp, setGaveUp] = useState(false);
  // Sunucuda sessionStorage yok: '/' ile render edilir, istemcide okunan degerle guncellenir.
  const back = useSyncExternalStore(noopSubscribe, readReturnPath, () => '/');

  useEffect(() => {
    if (!id) return;
    const until = Date.now() + POLL_LIMIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const t = await api<TopUpView>(`/payments/topups/${encodeURIComponent(id)}`);
        if (stopped) return;
        setTopUp(t);
        if (t.status !== 'PENDING') return;
      } catch (err) {
        if (!stopped) setError(err);
        return;
      }
      if (Date.now() > until) {
        setGaveUp(true);
        return;
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id]);

  if (!id) {
    return (
      <>
        <Alert>
          Ödeme sonucu okunamadı. Kartınızdan çekim yapıldıysa bakiyeniz birkaç dakika içinde
          yüklenir.
        </Alert>
        <LinkButton href="/wallet">Bakiyeye git</LinkButton>
      </>
    );
  }
  if (error !== null) return <Alert>{errorMessage(error)}</Alert>;
  if (!topUp) return <Loading label="Ödeme sonucu alınıyor…" />;

  return (
    <>
      {topUp.status === 'SUCCEEDED' && (
        <Alert tone="success">{tl(topUp.amountKurus)} bakiyenize yüklendi.</Alert>
      )}
      {topUp.status === 'PENDING' &&
        (gaveUp ? (
          <Alert tone="info">
            Ödeme sonucu henüz gelmedi. Kartınızdan çekim yapıldıysa bakiyeniz birkaç dakika içinde
            otomatik yüklenir; tekrar ödeme yapmayın.
          </Alert>
        ) : (
          <Loading label="Ödeme sonucu bekleniyor…" />
        ))}
      {(topUp.status === 'FAILED' || topUp.status === 'EXPIRED') && (
        <Alert>Ödeme tamamlanmadı; kartınızdan çekim yapılmadı. Tekrar deneyebilirsiniz.</Alert>
      )}
      {(topUp.status === 'REVERSAL_PENDING' || topUp.status === 'REVERSED') && (
        <Alert tone="warning">
          Hesabınız kapalı olduğu için ödeme bakiyeye yazılmadı ve kartınıza iade ediliyor.
        </Alert>
      )}
      {topUp.status !== 'PENDING' || gaveUp ? (
        <LinkButton href={back}>{back === '/' ? 'Ana sayfa' : 'Perona dön'}</LinkButton>
      ) : null}
      <LinkButton href="/wallet" variant="secondary">
        Bakiye
      </LinkButton>
    </>
  );
}

export default function TopUpResultPage() {
  const auth = useRequireAuth();
  return (
    <Page title="Ödeme sonucu">
      {auth.status === 'authenticated' ? (
        <Suspense fallback={<Loading />}>
          <Result />
        </Suspense>
      ) : (
        <Loading />
      )}
    </Page>
  );
}
