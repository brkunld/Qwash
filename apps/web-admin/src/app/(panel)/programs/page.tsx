'use client';

import type { AdminBayView, AdminProgram, AdminStation } from '@qwash/contracts';
import { useState, type FormEvent } from 'react';
import { useIsSuper } from '@/components/shell';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmButton,
  Empty,
  Field,
  Loading,
  PageHeader,
  Select,
} from '@/components/ui';
import { api } from '@/lib/api';
import { parseTl, pricePerSecond, tl } from '@/lib/format';
import { useAction, useLoad } from '@/lib/hooks';

export default function ProgramsPage() {
  const isSuper = useIsSuper();
  const stations = useLoad(() => api<AdminStation[]>('/admin/stations'), []);
  const [picked, setPicked] = useState<string | null>(null);
  const stationId = stations.data?.find((s) => s.id === picked)?.id ?? stations.data?.[0]?.id ?? '';
  const [savedBay, setSavedBay] = useState<string | null>(null);
  const programs = useLoad(
    () => api<AdminProgram[]>(`/admin/programs?stationId=${stationId}`),
    [stationId],
  );
  const bays = useLoad(() => api<AdminBayView[]>('/admin/bays'), []);

  if (!isSuper) {
    return (
      <>
        <PageHeader title="Programlar" />
        <Alert tone="info">Program ve tarife yönetimi yalnız süper yönetici içindir.</Alert>
      </>
    );
  }

  const station = stations.data?.find((s) => s.id === stationId);
  const stationBays = (bays.data ?? []).filter((b) => b.stationCode === station?.code);

  return (
    <>
      <PageHeader
        title="Programlar ve tarife"
        subtitle="Fiyat değişikliği yalnız yeni seansları etkiler; süren seans başladığı fiyatla biter. Silinen program geçmiş kayıtlarda kalır."
      />
      {(stations.error || programs.error) && <Alert>{stations.error ?? programs.error}</Alert>}
      {stations.loading && !stations.data && <Loading />}
      {stations.data && (
        <Card className="mb-4">
          <Select
            label="İstasyon"
            value={stationId}
            onChange={(e) => setPicked(e.target.value)}
            className="max-w-xs"
          >
            {stations.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </Card>
      )}

      {stationId && (
        <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
          <div className="flex flex-col gap-4">
            {programs.data?.length === 0 && (
              <Card>
                <Empty>Bu istasyonda program yok. Sağdan ekleyin.</Empty>
              </Card>
            )}
            {programs.data?.map((p) => (
              <ProgramCard key={p.id} program={p} onChanged={programs.reload} />
            ))}
          </div>
          <div className="flex flex-col gap-4">
            <CreateProgram stationId={stationId} onCreated={programs.reload} />
          </div>
        </div>
      )}

      {stationId && programs.data && stationBays.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-3 text-lg font-bold">Peron / röle eşleme</h2>
          <div className="grid gap-4 xl:grid-cols-2">
            {stationBays.map((b) => (
              <BayMapping
                // Sunucudaki esleme degisince form yeniden kurulur (kaydet, program ekle/sil).
                key={`${b.id}:${JSON.stringify(programs.data!.map((p) => p.bays))}`}
                bay={b}
                programs={programs.data!}
                saved={savedBay === b.id}
                onEdited={() => setSavedBay(null)}
                onSaved={async () => {
                  setSavedBay(b.id);
                  await programs.reload();
                }}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function ProgramCard({
  program: p,
  onChanged,
}: {
  program: AdminProgram;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [description, setDescription] = useState(p.description ?? '');
  const [icon, setIcon] = useState(p.icon ?? '');
  const [price, setPrice] = useState(String(p.pricePerSecondKurus / 100));
  const [active, setActive] = useState(p.isActive);
  const save = useAction();
  const del = useAction();
  const priceKurus = parseTl(price);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!priceKurus) return;
    const res = await save.run(() =>
      api(`/admin/programs/${p.id}`, {
        method: 'PUT',
        body: {
          name,
          description: description.trim() || null,
          icon: icon.trim() || null,
          pricePerSecondKurus: priceKurus,
          isActive: active,
        },
      }),
    );
    if (res !== undefined) {
      setEditing(false);
      await onChanged();
    }
  }

  async function remove() {
    const res = await del.run(() => api(`/admin/programs/${p.id}`, { method: 'DELETE' }));
    if (res !== undefined) await onChanged();
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">
            {p.name} <code className="text-xs text-slate-500">{p.code}</code>
          </h3>
          <p className="text-sm text-slate-600">{pricePerSecond(p.pricePerSecondKurus)}</p>
        </div>
        <div className="flex gap-1.5">
          <Badge tone={p.isActive ? 'green' : 'slate'}>{p.isActive ? 'Aktif' : 'Pasif'}</Badge>
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Peronlar:{' '}
        {p.bays.length === 0
          ? 'hiçbirine atanmamış'
          : p.bays
              .map((b) => `${b.bayCode} → röle ${b.relayIndex}${b.isEnabled ? '' : ' (kapalı)'}`)
              .join(', ')}
      </p>

      {del.error && (
        <div className="mt-2">
          <Alert>{del.error}</Alert>
        </div>
      )}

      {!editing ? (
        <div className="mt-3 flex gap-2">
          <Button small variant="secondary" onClick={() => setEditing(true)}>
            Düzenle
          </Button>
          <ConfirmButton
            label="Sil"
            confirmLabel="Evet, sil"
            busy={del.busy}
            onConfirm={() => void remove()}
          />
        </div>
      ) : (
        <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Ad"
              value={name}
              onChange={(e) => setName(e.target.value)}
              minLength={2}
              required
            />
            <Field
              label="Fiyat (₺ / saniye)"
              hint={priceKurus ? `= ${tl(priceKurus * 60)} / dakika` : 'Örn: 0,50'}
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
            />
            <Field
              label="Açıklama"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <Field label="Simge" value={icon} onChange={(e) => setIcon(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Aktif (pasifken müşteri seçemez)
          </label>
          {save.error && <Alert>{save.error}</Alert>}
          <div className="flex gap-2">
            <Button type="submit" busy={save.busy} disabled={!priceKurus}>
              Kaydet
            </Button>
            <Button variant="secondary" onClick={() => setEditing(false)}>
              Vazgeç
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function CreateProgram({
  stationId,
  onCreated,
}: {
  stationId: string;
  onCreated: () => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const action = useAction();
  const priceKurus = parseTl(price);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!priceKurus) return;
    const res = await action.run(() =>
      api('/admin/programs', {
        method: 'POST',
        body: { stationId, code, name, pricePerSecondKurus: priceKurus },
      }),
    );
    if (res !== undefined) {
      setCode('');
      setName('');
      setPrice('');
      await onCreated();
    }
  }

  return (
    <Card title="Yeni program">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field
          label="Kod"
          hint="2-20 karakter: harf, rakam, alt çizgi. Sonradan değişmez."
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          required
        />
        <Field
          label="Ad"
          value={name}
          onChange={(e) => setName(e.target.value)}
          minLength={2}
          required
        />
        <Field
          label="Fiyat (₺ / saniye)"
          hint={priceKurus ? `= ${tl(priceKurus * 60)} / dakika` : 'Örn: 0,50'}
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          required
        />
        {action.error && <Alert>{action.error}</Alert>}
        <Button type="submit" busy={action.busy} disabled={!priceKurus}>
          Ekle
        </Button>
        <p className="text-xs text-slate-500">
          Eklenen program peronlara atanana kadar müşteriye görünmez.
        </p>
      </form>
    </Card>
  );
}

interface MapRow {
  programId: string;
  assigned: boolean;
  relayIndex: number;
  isEnabled: boolean;
}

function BayMapping({
  bay,
  programs,
  saved,
  onEdited,
  onSaved,
}: {
  bay: AdminBayView;
  programs: AdminProgram[];
  saved: boolean;
  onEdited: () => void;
  onSaved: () => Promise<void>;
}) {
  const initial = (): MapRow[] =>
    programs.map((p) => {
      const cur = p.bays.find((b) => b.bayId === bay.id);
      return {
        programId: p.id,
        assigned: !!cur,
        relayIndex: cur?.relayIndex ?? 1,
        isEnabled: cur?.isEnabled ?? true,
      };
    });
  const [rows, setRows] = useState<MapRow[]>(initial);
  const action = useAction();

  const used = rows.filter((r) => r.assigned).map((r) => r.relayIndex);
  const conflict = new Set(used).size !== used.length;

  function patch(programId: string, change: Partial<MapRow>) {
    onEdited();
    setRows((rs) => rs.map((r) => (r.programId === programId ? { ...r, ...change } : r)));
  }

  async function save() {
    const res = await action.run(() =>
      api(`/admin/bays/${bay.id}/programs`, {
        method: 'PUT',
        body: {
          programs: rows
            .filter((r) => r.assigned)
            .map(({ programId, relayIndex, isEnabled }) => ({ programId, relayIndex, isEnabled })),
        },
      }),
    );
    if (res !== undefined) await onSaved();
  }

  return (
    <Card title={`${bay.name} (${bay.bayCode})`}>
      {programs.length === 0 ? (
        <Empty>Önce program ekleyin.</Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {programs.map((p) => {
            const row = rows.find((r) => r.programId === p.id);
            if (!row) return null;
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex min-w-40 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={row.assigned}
                    onChange={(e) => patch(p.id, { assigned: e.target.checked })}
                  />
                  {p.name}
                </label>
                <select
                  aria-label={`${p.name} röle kanalı`}
                  disabled={!row.assigned}
                  value={row.relayIndex}
                  onChange={(e) => patch(p.id, { relayIndex: Number(e.target.value) })}
                  className="rounded-lg border border-slate-300 px-2 py-1 disabled:opacity-40"
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      Röle {n}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    disabled={!row.assigned}
                    checked={row.isEnabled}
                    onChange={(e) => patch(p.id, { isEnabled: e.target.checked })}
                  />
                  açık
                </label>
              </div>
            );
          })}
          {conflict && <Alert tone="warning">Aynı röle kanalı iki programa atanmış.</Alert>}
          {action.error && <Alert>{action.error}</Alert>}
          {saved && <Alert tone="success">Kaydedildi.</Alert>}
          <div className="mt-1">
            <Button small busy={action.busy} disabled={conflict} onClick={() => void save()}>
              Eşlemeyi kaydet
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
