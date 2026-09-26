'use client';

import type {
  BayClaimView,
  BayUnavailableReason,
  BayView,
  SessionView,
  WalletView,
} from '@qwash/contracts';
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
  CLAIMED: 'Peron ekranı şu an başka bir müşteride. Birazdan tekrar deneyin.',
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
  // Dokunmatik ekrandan secim: peron ekrani bu hesaba bagli (paket ekrandan secilir).
  const [claim, setClaim] = useState<BayClaimView | null>(null);
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState<unknown>(null);
  const [now, setNow] = useState(() => Date.now());
  // Bagin bitisi bu cihazin saatiyle (sunucu saat farki duzeltilmis).
  const [claimDeadline, setClaimDeadline] = useState(0);
  // Musteri telefondan secmeyi secerse otomatik baglama bir daha denenmez.
  const [phoneMode, setPhoneMode] = useState(false);
  const autoClaimTried = useRef(false);

  const applyClaim = useCallback((c: BayClaimView | null) => {
    if (c) setClaimDeadline(Date.now() + Date.parse(c.expiresAt) - Date.parse(c.serverTime));
    setClaim(c);
  }, []);

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
    api<BayClaimView | null>(`/bays/${encodeURIComponent(bayCode)}/claim`)
      .then(applyClaim)
      .catch(() => undefined);
  }, [auth.status, bayCode, applyClaim]);

  // QR okutulup peron onaylaninca ekran otomatik bu hesaba baglanir: paketler peron ekranina gelir.
  useEffect(() => {
    if (!confirmed || auth.status !== 'authenticated' || !bay?.available) return;
    if (claim || active || phoneMode || autoClaimTried.current) return;
    autoClaimTried.current = true;
    api<BayClaimView>(`/bays/${encodeURIComponent(bayCode)}/claim`, { method: 'POST' })
      .then(applyClaim)
      .catch((err: unknown) => setClaimError(err));
  }, [confirmed, auth.status, bay, claim, active, phoneMode, bayCode, applyClaim]);

  // Bag acikken: geri sayim ve ekrandan baslatilan seansi yakalama (telefon acik kaldiysa).
  useEffect(() => {
    if (!claim) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => {
      api<SessionView | null>('/sessions/active')
        .then((s) => {
          if (s && s.bayCode === claim.bayCode) router.push(`/session/${s.sessionId}`);
        })
        .catch(() => undefined);
      api<BayClaimView | null>(`/bays/${encodeURIComponent(claim.bayCode)}/claim`)
        .then(applyClaim)
        .catch(() => undefined);
    }, 3000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [claim, router, applyClaim]);

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
  // Ekran bana bagliysa "baska musteride" uyarisi bana gosterilmez.
  const usable = bay.available || (claim !== null && bay.unavailableReason === 'CLAIMED');
  const claimLeftSec = claim ? Math.max(0, Math.ceil((claimDeadline - now) / 1000)) : 0;

  async function claimScreen() {
    setClaimBusy(true);
    setClaimError(null);
    try {
      applyClaim(
        await api<BayClaimView>(`/bays/${encodeURIComponent(bay!.bayCode)}/claim`, {
          method: 'POST',
        }),
      );
    } catch (err) {
      setClaimError(err);
      loadBay();
    } finally {
      setClaimBusy(false);
    }
  }

  async function releaseScreen() {
    setClaimBusy(true);
    try {
      await api(`/bays/${encodeURIComponent(bay!.bayCode)}/claim/release`, { method: 'POST' });
      setClaim(null);
      setPhoneMode(true);
      loadBay();
    } catch (err) {
      setClaimError(err);
    } finally {
      setClaimBusy(false);
    }
  }

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

      {!usable ? (
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
      ) : claim ? (
        <>
          <Card className="text-center">
            <p className="text-lg font-semibold">Peron ekranı hesabınıza bağlandı</p>
            <p className="mt-2 text-sm text-slate-600">
              Paketi ve süreyi peronun dokunmatik ekranından seçin; ücret bakiyenizden düşer.
              Telefona tekrar gerek yok. Yıkama sürerken ekrandaki <strong>DURDUR</strong> ile erken
              bitirebilirsiniz.
            </p>
            {claimLeftSec > 0 && (
              <p className="mt-3 text-sm text-slate-600">
                {claimLeftSec} sn içinde seçim yapılmazsa bağlantı kapanır.
              </p>
            )}
            {wallet && (
              <p className="mt-1 text-sm text-slate-600">
                Kullanılabilir bakiye: {tl(wallet.availableKurus)}
              </p>
            )}
          </Card>
          {claimError !== null && <Alert>{errorMessage(claimError)}</Alert>}
          <Button variant="secondary" onClick={releaseScreen} busy={claimBusy}>
            Bırak ve telefondan seç
          </Button>
        </>
      ) : (
        <>
          <Card className="text-center">
            <p className="font-semibold">Paketi peron ekranından seçin</p>
            <p className="mt-1 text-sm text-slate-600">
              Ekran hesabınıza bağlanır, paketi dokunarak seçersiniz. Ücret bakiyenizden düşer.
            </p>
            <div className="mt-3">
              <Button onClick={claimScreen} busy={claimBusy} disabled={active !== null}>
                Ekrandan seçeceğim
              </Button>
            </div>
          </Card>
          {claimError !== null && <Alert>{errorMessage(claimError)}</Alert>}
          <p className="text-center text-sm text-slate-500">veya buradan seçin</p>
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
                      ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-200'
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
                      ? 'border-brand-500 bg-brand-500 text-slate-900'
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
