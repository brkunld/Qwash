'use client';

import {
  OUT_OF_SERVICE_NOTE_MAX,
  type AdminBayView,
  type AdminStation,
  type StationAvailabilityResult,
} from '@qwash/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Empty, Field, Loading, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { ago, durationLabel } from '@/lib/format';
import { useAction, useLoad, useNow } from '@/lib/hooks';

/** Cihaz bu sureden uzun sessizse sari, cok uzunsa kirmizi (backend deviceStaleMs 90 sn). */
const STALE_WARN_MS = 45_000;

const PROBLEMS: Record<string, string> = {
  MAINTENANCE: 'Bakımda',
  CLOSED: 'Kapalı',
  NO_DEVICE: 'Cihaz bağlı değil',
  DEVICE_STALE: 'Cihaz sessiz',
  DEVICE_OFFLINE: 'Cihaz çevrimdışı',
  DEVICE_ERROR: 'Cihaz hata bildiriyor',
  DEVICE_BUSY: 'Cihaz meşgul',
};

const STATUS_LABEL: Record<string, string> = {
  IDLE: 'Boşta',
  WAITING: 'Bekliyor',
  RUNNING: 'Çalışıyor',
  OFFLINE: 'Çevrimdışı',
  MAINTENANCE: 'Bakımda',
  ERROR: 'Hata',
};

const NOTE_HINT = `Cihaz ekranında ve müşteri sayfasında görünür (en fazla ${OUT_OF_SERVICE_NOTE_MAX} karakter; ekranda Türkçe harfler sadeleşir).`;

const DRIFT_LABEL: Record<string, string> = {
  UNEXPECTED_RUNNING: 'Cihaz beklenmedik şekilde çalışıyor',
  SESSION_MISMATCH: 'Cihazdaki seans farklı',
  NOT_RUNNING: 'Cihaz seansı çalıştırmıyor',
  RELAY_MISMATCH: 'Röle uyuşmuyor',
};

export default function BaysPage() {
  const bays = useLoad(() => api<AdminBayView[]>('/admin/bays'), [], 5000);
  const stations = useLoad(() => api<AdminStation[]>('/admin/stations'), []);

  return (
    <>
      <PageHeader
        title="Peronlar"
        subtitle="Canlı durum, 5 saniyede bir yenilenir. Cihaz sağlığı ve müşterinin peronu başlatıp başlatamayacağı."
      />
      {bays.error && <Alert>{bays.error}</Alert>}
      {stations.data?.map((st) => (
        <StationBar
          key={st.id}
          station={st}
          bays={bays.data?.filter((b) => b.stationCode === st.code) ?? []}
          onChanged={bays.reload}
        />
      ))}
      {bays.loading && !bays.data && <Loading />}
      {bays.data?.length === 0 && (
        <Card>
          <Empty>Henüz peron yok. Veritabanına istasyon ve peron eklenmeli (pnpm db:seed).</Empty>
        </Card>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {bays.data?.map((bay) => (
          <BayCard key={bay.id} bay={bay} onChanged={bays.reload} />
        ))}
      </div>
    </>
  );
}

/** Istasyonun tum peronlarini kapatip acma (gece, tatil). Bakimdaki peronlara dokunmaz. */
function StationBar({
  station,
  bays,
  onChanged,
}: {
  station: AdminStation;
  bays: AdminBayView[];
  onChanged: () => Promise<void>;
}) {
  const action = useAction();
  const [showClose, setShowClose] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const closed = bays.filter((b) => b.outOfService?.kind === 'CLOSED').length;
  const open = bays.filter((b) => !b.outOfService).length;

  async function apply(state: 'OPEN' | 'CLOSED') {
    const res = await action.run(() =>
      api<StationAvailabilityResult>(`/admin/stations/${station.id}/availability`, {
        method: 'PUT',
        body: state === 'OPEN' ? { state } : { state, reason, note },
      }),
    );
    if (res) {
      setShowClose(false);
      setReason('');
      setNote('');
      setResult(
        `${res.changed} peron ${state === 'OPEN' ? 'açıldı' : 'kapatıldı'}` +
          (res.skippedMaintenance
            ? `, ${res.skippedMaintenance} bakımdaki perona dokunulmadı`
            : '') +
          '.',
      );
      await onChanged();
    }
  }

  return (
    <div className="mb-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-bold">{station.name}</h2>
            <p className="text-xs text-slate-500">
              {station.code} · {open} açık · {closed} kapalı · {bays.length - open - closed} bakımda
            </p>
          </div>
          <div className="flex gap-2">
            {closed > 0 && (
              <Button variant="secondary" small busy={action.busy} onClick={() => apply('OPEN')}>
                İstasyonu aç
              </Button>
            )}
            {open > 0 && (
              <Button variant="secondary" small onClick={() => setShowClose((v) => !v)}>
                İstasyonu kapat
              </Button>
            )}
          </div>
        </div>
        {action.error && <p className="mt-2 text-sm text-red-700">{action.error}</p>}
        {result && <p className="mt-2 text-sm text-slate-600">{result}</p>}
        {showClose && (
          <form
            className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              void apply('CLOSED');
            }}
          >
            <Field
              label="İç not (isteğe bağlı)"
              placeholder="Gece kapanışı"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
            />
            <Field
              label="Müşteriye not (isteğe bağlı)"
              placeholder="Sabah 07:00'de açılır"
              hint={NOTE_HINT}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={OUT_OF_SERVICE_NOTE_MAX}
            />
            <Button type="submit" busy={action.busy}>
              Tüm açık peronları kapat
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}

function BayCard({ bay, onChanged }: { bay: AdminBayView; onChanged: () => Promise<void> }) {
  const avail = useAction();
  const stop = useAction();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [stopReason, setStopReason] = useState('');
  const [form, setForm] = useState<'MAINTENANCE' | 'CLOSED' | null>(null);
  const [showStop, setShowStop] = useState(false);
  const oos = bay.outOfService;

  const now = useNow(5000);
  const silentMs = bay.device ? now - Date.parse(bay.device.lastSeenAt) : null;
  const deviceTone =
    !bay.device || (silentMs ?? 0) > 90_000
      ? 'red'
      : (silentMs ?? 0) > STALE_WARN_MS || bay.device.reportedStatus !== 'ONLINE'
        ? 'amber'
        : 'green';
  const s = bay.activeSession;

  async function setAvailability(state: 'OPEN' | 'MAINTENANCE' | 'CLOSED') {
    const ok = await avail.run(() =>
      api(`/admin/bays/${bay.id}/availability`, {
        method: 'PUT',
        body: state === 'OPEN' ? { state } : { state, reason, note },
      }),
    );
    if (ok !== undefined) {
      setForm(null);
      setReason('');
      setNote('');
      await onChanged();
    }
  }

  async function emergencyStop() {
    if (!s) return;
    const ok = await stop.run(() =>
      api(`/admin/sessions/${s.id}/stop`, { method: 'POST', body: { reason: stopReason } }),
    );
    if (ok !== undefined) {
      setShowStop(false);
      setStopReason('');
      await onChanged();
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">{bay.name}</h2>
          <p className="text-xs text-slate-500">
            {bay.bayCode} · {bay.stationCode}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          <Badge
            tone={bay.status === 'RUNNING' ? 'blue' : bay.status === 'ERROR' ? 'red' : 'slate'}
          >
            {STATUS_LABEL[bay.status] ?? bay.status}
          </Badge>
          {bay.problem === 'CLOSED' ? (
            <Badge tone="slate">Kapalı</Badge>
          ) : bay.problem ? (
            <Badge tone="amber">Başlatılamaz: {PROBLEMS[bay.problem] ?? bay.problem}</Badge>
          ) : (
            <Badge tone="green">Başlatılabilir</Badge>
          )}
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-slate-500">Cihaz</dt>
        <dd>
          {bay.device ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <code className="text-xs">{bay.device.deviceId}</code>
              <Badge tone={deviceTone}>{bay.device.reportedStatus}</Badge>
            </span>
          ) : (
            <Badge tone="red">Bağlı cihaz yok</Badge>
          )}
        </dd>
        {bay.device && (
          <>
            <dt className="text-slate-500">Son sinyal</dt>
            <dd>{ago(bay.device.lastSeenAt)}</dd>
            <dt className="text-slate-500">Yazılım</dt>
            <dd>{bay.device.firmwareVersion ?? '—'}</dd>
            <dt className="text-slate-500">Son açılış nedeni</dt>
            <dd>
              {bay.device.resetReason ?? '—'}
              {bay.device.resetReason === 6 && (
                <span className="ml-1 text-xs text-red-700">(watchdog reseti)</span>
              )}
            </dd>
          </>
        )}
      </dl>

      {bay.device?.driftConfirmedAt && (
        <div className="mt-3">
          <Alert tone="warning">
            Cihaz–backend uyuşmazlığı:{' '}
            {DRIFT_LABEL[bay.device.driftKind ?? ''] ?? bay.device.driftKind}. Cihazı fiziksel
            olarak kontrol edin.
          </Alert>
        </div>
      )}

      {s && (
        <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">
          <p className="font-semibold">
            Aktif seans: {s.programCode} · {durationLabel(s.plannedDurationSec)}{' '}
            <Badge tone="blue">{s.status}</Badge>
          </p>
          <p className="text-xs text-slate-500">
            Başladı: {s.startedAt ? ago(s.startedAt) : 'henüz başlamadı'} ·{' '}
            <Link href={`/users/${s.userId}`} className="underline">
              müşteri
            </Link>
            {s.stopRequestedAt && ' · durdurma istendi'}
          </p>
        </div>
      )}

      {oos && (
        <div className="mt-3">
          <Alert tone={oos.kind === 'MAINTENANCE' ? 'warning' : 'info'}>
            <p>
              <span className="font-semibold">
                {oos.kind === 'MAINTENANCE' ? 'Bakımda' : 'Kapalı'}
              </span>{' '}
              ({ago(oos.since)}){oos.reason && <>: {oos.reason}</>}
            </p>
            <p className="mt-1">
              Müşteri notu:{' '}
              {oos.note ? <q>{oos.note}</q> : <span className="text-slate-500">yok</span>}
            </p>
            <p className="mt-1 text-xs">Süren seans kesilmez; yeni seans başlatılamaz.</p>
          </Alert>
        </div>
      )}

      {bay.device && !bay.deviceInSync && (
        <p className="mt-2 text-xs text-amber-800">
          Cihaz ekranı henüz güncellenmedi. Cihaz çevrimdışıysa bağlanınca güncellenir; yazılımı
          0.8.0&apos;dan eskiyse ekranda gösterilemez.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {oos ? (
          <Button
            variant="secondary"
            small
            busy={avail.busy}
            onClick={() => setAvailability('OPEN')}
          >
            Hizmete aç
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              small
              onClick={() => setForm((f) => (f === 'MAINTENANCE' ? null : 'MAINTENANCE'))}
            >
              Bakıma al
            </Button>
            <Button
              variant="secondary"
              small
              onClick={() => setForm((f) => (f === 'CLOSED' ? null : 'CLOSED'))}
            >
              Kapat
            </Button>
          </>
        )}
        {s &&
          (s.status === 'RUNNING' ||
            s.status === 'STARTING' ||
            (s.status === 'RECONCILING' && s.startedAt === null)) && (
            <Button variant="danger" small onClick={() => setShowStop((v) => !v)}>
              Acil durdur
            </Button>
          )}
      </div>

      {avail.error && <p className="mt-2 text-sm text-red-700">{avail.error}</p>}
      {stop.error && <p className="mt-2 text-sm text-red-700">{stop.error}</p>}

      {form && !oos && (
        <form
          className="mt-3 grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void setAvailability(form);
          }}
        >
          {form === 'MAINTENANCE' ? (
            <Field
              label="Bakım nedeni (iç not, müşteri görmez)"
              placeholder="Pompa arızası, teknisyen çağrıldı"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={3}
              maxLength={200}
              required
            />
          ) : (
            <Field
              label="İç not (isteğe bağlı, müşteri görmez)"
              placeholder="Peron temizliği"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
            />
          )}
          <Field
            label="Müşteriye not (isteğe bağlı)"
            placeholder={form === 'MAINTENANCE' ? "15:00'te açılır" : "Sabah 07:00'de açılır"}
            hint={NOTE_HINT}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={OUT_OF_SERVICE_NOTE_MAX}
          />
          <div>
            <Button type="submit" busy={avail.busy}>
              {form === 'MAINTENANCE' ? 'Bakıma al' : 'Kapat'}
            </Button>
          </div>
        </form>
      )}

      {showStop && s && (
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void emergencyStop();
          }}
        >
          <Field
            className="flex-1"
            label="Durdurma gerekçesi (en az 10 karakter)"
            hint="Suyu keser; müşteriden kullanılan süre kadar tahsil edilir."
            value={stopReason}
            onChange={(e) => setStopReason(e.target.value)}
            minLength={10}
            maxLength={500}
            required
          />
          <Button type="submit" variant="danger" busy={stop.busy}>
            Durdur
          </Button>
        </form>
      )}
    </Card>
  );
}
