'use client';

import type { AdminBayView } from '@qwash/contracts';
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

const DRIFT_LABEL: Record<string, string> = {
  UNEXPECTED_RUNNING: 'Cihaz beklenmedik şekilde çalışıyor',
  SESSION_MISMATCH: 'Cihazdaki seans farklı',
  NOT_RUNNING: 'Cihaz seansı çalıştırmıyor',
  RELAY_MISMATCH: 'Röle uyuşmuyor',
};

export default function BaysPage() {
  const bays = useLoad(() => api<AdminBayView[]>('/admin/bays'), [], 5000);

  return (
    <>
      <PageHeader
        title="Peronlar"
        subtitle="Canlı durum, 5 saniyede bir yenilenir. Cihaz sağlığı ve müşterinin peronu başlatıp başlatamayacağı."
      />
      {bays.error && <Alert>{bays.error}</Alert>}
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

function BayCard({ bay, onChanged }: { bay: AdminBayView; onChanged: () => Promise<void> }) {
  const maint = useAction();
  const stop = useAction();
  const [reason, setReason] = useState('');
  const [stopReason, setStopReason] = useState('');
  const [showMaint, setShowMaint] = useState(false);
  const [showStop, setShowStop] = useState(false);

  const now = useNow(5000);
  const silentMs = bay.device ? now - Date.parse(bay.device.lastSeenAt) : null;
  const deviceTone =
    !bay.device || (silentMs ?? 0) > 90_000
      ? 'red'
      : (silentMs ?? 0) > STALE_WARN_MS || bay.device.reportedStatus !== 'ONLINE'
        ? 'amber'
        : 'green';
  const s = bay.activeSession;

  async function setMaintenance(enabled: boolean) {
    const ok = await maint.run(() =>
      api('/admin/bays/' + bay.id + '/maintenance', {
        method: 'PUT',
        body: enabled ? { enabled, reason } : { enabled },
      }),
    );
    if (ok !== undefined) {
      setShowMaint(false);
      setReason('');
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
          {bay.problem ? (
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

      {bay.maintenance && (
        <div className="mt-3">
          <Alert tone="warning">
            Bakım modu: {bay.maintenance.reason ?? '—'} ({ago(bay.maintenance.since)}). Süren seans
            kesilmez; yeni seans başlatılamaz.
          </Alert>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {bay.maintenance ? (
          <Button variant="secondary" small busy={maint.busy} onClick={() => setMaintenance(false)}>
            Bakımdan çıkar
          </Button>
        ) : (
          <Button variant="secondary" small onClick={() => setShowMaint((v) => !v)}>
            Bakıma al
          </Button>
        )}
        {s && (s.status === 'RUNNING' || s.status === 'STARTING') && (
          <Button variant="danger" small onClick={() => setShowStop((v) => !v)}>
            Acil durdur
          </Button>
        )}
      </div>

      {maint.error && <p className="mt-2 text-sm text-red-700">{maint.error}</p>}
      {stop.error && <p className="mt-2 text-sm text-red-700">{stop.error}</p>}

      {showMaint && !bay.maintenance && (
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void setMaintenance(true);
          }}
        >
          <Field
            className="flex-1"
            label="Bakım nedeni"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={3}
            maxLength={200}
            required
          />
          <Button type="submit" busy={maint.busy}>
            Bakıma al
          </Button>
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
