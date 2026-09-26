'use client';

import type { BayUnavailableReason, BayView, SessionView, WalletView } from '@qwash/contracts';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, LinkButton, Loading, Page } from '@/components/ui';
import { api, newIdempotencyKey } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorCode, errorMessage } from '@/lib/errors';
import { durationLabel, tl } from '@/lib/format';

/** Sure secenekleri (sn). Musteri erken durdurursa yalniz kullandigini oder. */
const DURATIONS = [60, 120, 180, 300, 600];

const UNAVAILABLE: Record<BayUnavailableReason, string> = {
  MAINTENANCE: 'Peron bakımda.',
  NO_DEVICE: 'Peron henüz hizmete açılmadı.',
  DEVICE_OFFLINE: 'Peron cihazı şu an çevrimdışı.',
  DEVICE_STALE: 'Peron cihazından bir süredir haber alınamıyor.',
  BUSY: 'Bu peronda şu an başka bir yıkama sürüyor.',
};

export default function BayPage() {
  const { bayCode } = useParams<{ bayCode: string }>();
  const router = useRouter();
  const auth = useAuth();
  const [bay, setBay] = useState<BayView | null>(null);
  const [bayError, setBayError] = useState<string | null>(null);
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [active, setActive] = useState<SessionView | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [program, setProgram] = useState<string | null>(null);
  const [duration, setDuration] = useState(DURATIONS[1]!);
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);
  // Ayni secim icin ayni anahtar: cift dokunma veya ag hatasi sonrasi tekrar ikinci seans
  // acmaz. Secim degisince yeni anahtar (farkli parametreyle eski anahtar 409 verir).
  const idemKey = useRef(newIdempotencyKey());

  const loadBay = useCallback(() => {
    api<BayView>(`/bays/${encodeURIComponent(bayCode)}`, { auth: false })
      .then((b) => {
        setBay(b);
        setBayError(null);
        setProgram((p) => p ?? b.programs[0]?.code ?? null);
      })
      .catch((e: unknown) => setBayError(errorMessage(e)));
  }, [bayCode]);

  useEffect(loadBay, [loadBay]);

  useEffect(() => {
    if (auth.status !== 'authenticated') return;
    api<WalletView>('/wallet')
      .then(setWallet)
      .catch(() => undefined);
    api<SessionView | null>('/sessions/active')
      .then(setActive)
      .catch(() => undefined);
  }, [auth.status]);

  useEffect(() => {
    idemKey.current = newIdempotencyKey();
  }, [program, duration]);

  if (bayError) {
    return (
      <Page>
        <Alert>{bayError}</Alert>
        <LinkButton href="/" variant="secondary">
          Ana sayfa
        </LinkButton>
      </Page>
    );
  }
  if (!bay)
    return (
      <Page>
        <Loading />
      </Page>
    );

  const selected = bay.programs.find((p) => p.code === program) ?? null;
  const durations = DURATIONS.filter((d) => d <= bay.maxDurationSec);
  const cost = selected ? selected.pricePerSecondKurus * duration : 0;
  const shortBy = wallet ? Math.max(0, cost - wallet.availableKurus) : 0;
  const here = `/b/${encodeURIComponent(bay.bayCode)}`;

  async function start() {
    if (!selected) return;
    setBusy(true);
    setStartError(null);
    try {
      const s = await api<SessionView>('/sessions', {
        method: 'POST',
        body: { bayCode: bay!.bayCode, programCode: selected.code, durationSec: duration },
        idempotencyKey: idemKey.current,
      });
      router.push(`/session/${s.sessionId}`);
    } catch (err) {
      setStartError(err);
      const code = errorCode(err);
      if (code === 'BAY_BUSY' || code === 'BAY_UNAVAILABLE' || code === 'PROGRAM_NOT_AVAILABLE') {
        loadBay();
      }
      if (code === 'INSUFFICIENT_FUNDS') {
        api<WalletView>('/wallet')
          .then(setWallet)
          .catch(() => undefined);
      }
      setBusy(false);
    }
  }

  return (
    <Page>
      {/* QR-jacking savunmasi (IOT.md): musteri hangi perona baglandigini acikca gorur. */}
      <Card className="text-center">
        <p className="text-sm text-slate-500">{bay.stationName}</p>
        <p className="mt-1 text-3xl font-extrabold">{bay.bayName}</p>
        <p className="mt-1 font-mono text-sm text-slate-500">{bay.bayCode}</p>
        <p className="mt-3 text-sm text-slate-600">
          Peron ekranında gördüğünüz kodla aynı olduğundan emin olun.
        </p>
      </Card>

      {active && (
        <Alert tone="info">
          Süren bir yıkamanız var ({active.bayName}).{' '}
          <Link href={`/session/${active.sessionId}`} className="font-semibold underline">
            Yıkamaya dön
          </Link>
        </Alert>
      )}

      {!bay.available ? (
        <>
          <Alert tone="warning">{UNAVAILABLE[bay.unavailableReason ?? 'DEVICE_OFFLINE']}</Alert>
          <Button variant="secondary" onClick={loadBay}>
            Tekrar kontrol et
          </Button>
        </>
      ) : !confirmed ? (
        <Button onClick={() => setConfirmed(true)}>Evet, bu perona bağlan</Button>
      ) : auth.status === 'loading' ? (
        <Loading />
      ) : auth.status === 'anonymous' ? (
        <>
          <Alert tone="info">Yıkamaya başlamak için giriş yapın.</Alert>
          <LinkButton href={`/login?next=${encodeURIComponent(here)}`}>Giriş yap</LinkButton>
          <LinkButton href={`/register?next=${encodeURIComponent(here)}`} variant="secondary">
            Hesap oluştur
          </LinkButton>
        </>
      ) : (
        <>
          <Card>
            <h2 className="mb-3 font-semibold">Program</h2>
            <div className="grid grid-cols-2 gap-2">
              {bay.programs.map((p) => (
                <button
                  key={p.code}
                  type="button"
                  onClick={() => setProgram(p.code)}
                  aria-pressed={p.code === program}
                  className={`min-h-16 rounded-xl border p-3 text-left ${
                    p.code === program
                      ? 'border-sky-600 bg-sky-50 ring-2 ring-sky-200'
                      : 'border-slate-300 bg-white'
                  }`}
                >
                  <span className="block font-semibold">{p.name}</span>
                  <span className="text-sm text-slate-600">
                    {tl(p.pricePerSecondKurus * 60)} / dk
                  </span>
                </button>
              ))}
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 font-semibold">Süre</h2>
            <div className="flex flex-wrap gap-2">
              {durations.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDuration(d)}
                  aria-pressed={d === duration}
                  className={`min-h-12 min-w-16 rounded-xl border px-3 font-semibold ${
                    d === duration
                      ? 'border-sky-600 bg-sky-600 text-white'
                      : 'border-slate-300 bg-white'
                  }`}
                >
                  {durationLabel(d)}
                </button>
              ))}
            </div>
            <p className="mt-4 text-sm text-slate-600">
              En fazla <strong className="text-slate-900">{tl(cost)}</strong>. Erken durdurursanız
              yalnız kullandığınız süre ödenir, kalanı bakiyenizde kalır.
            </p>
            {wallet && (
              <p className="mt-1 text-sm text-slate-600">
                Kullanılabilir bakiye: {tl(wallet.availableKurus)}
              </p>
            )}
          </Card>

          {startError !== null && <Alert>{errorMessage(startError)}</Alert>}
          {shortBy > 0 ? (
            <>
              <Alert tone="warning">
                Bu süre için {tl(shortBy)} eksik. Süreyi kısaltın veya bakiye yükleyin.
              </Alert>
              <LinkButton href={`/wallet?next=${encodeURIComponent(here)}`}>
                Bakiye yükle
              </LinkButton>
            </>
          ) : (
            <Button onClick={start} busy={busy} disabled={!selected || active !== null}>
              Yıkamayı başlat
            </Button>
          )}
        </>
      )}
    </Page>
  );
}
