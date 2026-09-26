'use client';

import type { SessionView } from '@qwash/contracts';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Card, LinkButton, Loading, Page } from '@/components/ui';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { clock, tl } from '@/lib/format';
import { isTerminal, useLiveSession, useRemainingSeconds } from '@/lib/live-session';

/** Cihaz kaynakli bitis nedenleri; digerleri teknik ariza sayilir. */
function failureText(reason: string | null): string {
  if (reason === 'ACK_TIMEOUT') return 'Peron komuta yanıt vermedi.';
  if (reason?.startsWith('DEVICE_REJECTED')) return 'Peron yıkamayı başlatamadı.';
  return 'Yıkama başlatılamadı.';
}

function LiveSession({ id }: { id: string }) {
  const { view, connection, offsetMs, error, reload } = useLiveSession(id);
  const remaining = useRemainingSeconds(view, offsetMs);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<unknown>(null);

  if (!view) {
    return error ? (
      <>
        <Alert>{errorMessage(error)}</Alert>
        <Button variant="secondary" onClick={reload}>
          Tekrar dene
        </Button>
      </>
    ) : (
      <Loading />
    );
  }

  async function stop() {
    setStopping(true);
    setStopError(null);
    try {
      await api<SessionView>(`/sessions/${id}/stop`, { method: 'POST' });
      reload();
    } catch (err) {
      setStopError(err);
    } finally {
      setStopping(false);
    }
  }

  const bayLink = `/b/${encodeURIComponent(view.bayCode)}`;

  return (
    <>
      <Card className="text-center">
        <p className="text-sm text-slate-500">
          {view.bayName} · {view.programName}
        </p>

        {view.status === 'STARTING' && (
          <>
            <p className="mt-6 text-2xl font-bold">Peron başlatılıyor…</p>
            <p className="mt-2 text-sm text-slate-600">
              Cihazın onayı bekleniyor (en fazla 10 sn).
            </p>
          </>
        )}

        {view.status === 'RUNNING' && (
          <>
            <p className="mt-4 font-mono text-7xl font-extrabold tabular-nums" aria-live="off">
              {remaining === null ? '–' : clock(remaining)}
            </p>
            <p className="mt-2 text-sm text-slate-600">kalan süre</p>
            {view.stopRequested && (
              <p className="mt-3 text-sm font-semibold text-amber-700">Durduruluyor…</p>
            )}
          </>
        )}

        {view.status === 'RECONCILING' && (
          <>
            <p className="mt-6 text-xl font-bold">Peron bağlantısı bekleniyor</p>
            <p className="mt-2 text-sm text-slate-600">
              Yıkamanız cihazda tamamlandı ama sonuç henüz bize ulaşmadı. Yalnız kullandığınız süre
              ücretlendirilir; en geç 30 dakika içinde kesinleşir.
            </p>
          </>
        )}

        {view.status === 'COMPLETED' && (
          <>
            <p className="mt-6 text-2xl font-bold text-emerald-700">Yıkama tamamlandı</p>
            <dl className="mt-4 grid grid-cols-2 gap-2 text-left text-sm">
              <dt className="text-slate-500">Kullanılan süre</dt>
              <dd className="text-right font-semibold">{clock(view.usedSeconds ?? 0)}</dd>
              <dt className="text-slate-500">Ödenen</dt>
              <dd className="text-right font-semibold">{tl(view.chargedKurus ?? 0)}</dd>
              <dt className="text-slate-500">Bakiyeye dönen</dt>
              <dd className="text-right font-semibold">
                {tl(view.heldKurus - (view.chargedKurus ?? 0))}
              </dd>
            </dl>
          </>
        )}

        {view.status === 'FAILED' && (
          <>
            <p className="mt-6 text-2xl font-bold text-red-700">{failureText(view.endReason)}</p>
            <p className="mt-2 text-sm text-slate-600">
              Ücret alınmadı; ayrılan {tl(view.heldKurus)} bakiyenize geri döndü.
            </p>
          </>
        )}
      </Card>

      {connection === 'offline' && !isTerminal(view) && (
        <Alert tone="warning">
          Canlı bağlantı koptu; durum birkaç saniyede bir yenileniyor. Peron yıkamaya devam eder.
        </Alert>
      )}
      {stopError !== null && <Alert>{errorMessage(stopError)}</Alert>}

      {(view.status === 'STARTING' || view.status === 'RUNNING') && !view.stopRequested && (
        <Button variant="danger" onClick={stop} busy={stopping}>
          Durdur
        </Button>
      )}

      {isTerminal(view) && (
        <>
          <LinkButton href={bayLink}>Yeni yıkama</LinkButton>
          <LinkButton href="/" variant="secondary">
            Ana sayfa
          </LinkButton>
        </>
      )}
    </>
  );
}

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const auth = useRequireAuth();
  return <Page>{auth.status === 'authenticated' ? <LiveSession id={id} /> : <Loading />}</Page>;
}
