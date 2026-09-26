'use client';

import type {
  AdminStation,
  AdminUserSummary,
  CashReport,
  CashTopUpReceipt,
} from '@qwash/contracts';
import { useState, type FormEvent } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Loading,
  PageHeader,
  Select,
  Table,
  TD,
  TH,
} from '@/components/ui';
import { api, newIdempotencyKey } from '@/lib/api';
import { dateTime, istanbulToday, parseTl, tl } from '@/lib/format';
import { useAction, useLoad } from '@/lib/hooks';

const STATION_KEY = 'qwash.admin.station';

function readSavedStation(): string | null {
  try {
    return localStorage.getItem(STATION_KEY);
  } catch {
    return null; // sunucuda veya depolama kapaliyken
  }
}

export default function CashPage() {
  const stations = useLoad(() => api<AdminStation[]>('/admin/stations'), []);
  // Operator genellikle hep ayni istasyonda calisir: son secim hatirlanir.
  const [saved] = useState(readSavedStation);
  const [picked, setPicked] = useState<string | null>(null);
  // Yukleme yapilinca gun sonu raporu yeniden cekilir.
  const [reportVersion, setReportVersion] = useState(0);
  const list = stations.data ?? [];
  const stationId =
    list.find((s) => s.id === picked)?.id ??
    list.find((s) => s.id === saved)?.id ??
    list[0]?.id ??
    '';

  function pickStation(id: string) {
    setPicked(id);
    try {
      localStorage.setItem(STATION_KEY, id);
    } catch {
      /* yoksay */
    }
  }

  return (
    <>
      <PageHeader
        title="Kasa"
        subtitle="Müşteriden alınan nakdi bakiyesine yükleyin; gün sonunda kasayı raporla karşılaştırın."
      />
      {stations.error && <Alert>{stations.error}</Alert>}
      {stations.loading && !stations.data && <Loading />}
      {stations.data?.length === 0 && (
        <Alert tone="warning">İstasyon tanımlı değil (pnpm db:seed).</Alert>
      )}
      {stations.data && stations.data.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-2">
          <TopUpForm
            stations={stations.data}
            stationId={stationId}
            onStation={pickStation}
            onToppedUp={() => setReportVersion((v) => v + 1)}
          />
          <ReportCard stations={stations.data} stationId={stationId} version={reportVersion} />
        </div>
      )}
    </>
  );
}

function TopUpForm({
  stations,
  stationId,
  onStation,
  onToppedUp,
}: {
  stations: AdminStation[];
  stationId: string;
  onStation: (id: string) => void;
  onToppedUp: () => void;
}) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<AdminUserSummary[] | null>(null);
  const [customer, setCustomer] = useState<AdminUserSummary | null>(null);
  const [amount, setAmount] = useState('');
  const [key, setKey] = useState(newIdempotencyKey);
  const [receipt, setReceipt] = useState<CashTopUpReceipt | null>(null);
  const [confirming, setConfirming] = useState(false);
  const search = useAction();
  const submit = useAction();

  const amountKurus = parseTl(amount);

  async function doSearch(e: FormEvent) {
    e.preventDefault();
    const res = await search.run(() =>
      api<AdminUserSummary[]>(`/admin/users?q=${encodeURIComponent(q)}`),
    );
    if (res) setFound(res.filter((u) => u.status === 'ACTIVE'));
  }

  async function doTopUp() {
    if (!customer || !amountKurus) return;
    const res = await submit.run(() =>
      api<CashTopUpReceipt>('/admin/cash-topups', {
        method: 'POST',
        idempotencyKey: key,
        body: { userId: customer.id, stationId, amountKurus },
      }),
    );
    setConfirming(false);
    if (res) {
      setReceipt(res);
      setCustomer(null);
      setFound(null);
      setQ('');
      setAmount('');
      setKey(newIdempotencyKey()); // sonraki yukleme yeni anahtar
      onToppedUp();
    }
  }

  return (
    <Card title="Nakit yükleme">
      {receipt && (
        <div className="mb-4">
          <Alert tone="success">
            <p className="font-semibold">Yüklendi · Makbuz no {receipt.receiptNo}</p>
            <p>
              {receipt.userEmail} bakiyesine {tl(receipt.amountKurus)} eklendi. Yeni bakiye:{' '}
              {tl(receipt.balanceAfterKurus)} ({dateTime(receipt.createdAt)}).
            </p>
          </Alert>
        </div>
      )}
      <div className="flex flex-col gap-4">
        <Select label="İstasyon" value={stationId} onChange={(e) => onStation(e.target.value)}>
          {stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.code})
            </option>
          ))}
        </Select>

        {!customer ? (
          <>
            <form onSubmit={doSearch} className="flex items-end gap-2">
              <Field
                className="flex-1"
                label="Müşteri (e-posta veya ad)"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                minLength={2}
                required
              />
              <Button type="submit" busy={search.busy}>
                Bul
              </Button>
            </form>
            {search.error && <Alert>{search.error}</Alert>}
            {found && found.length === 0 && <Empty>Aktif müşteri bulunamadı.</Empty>}
            {found && found.length > 0 && (
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {found.map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      onClick={() => setCustomer(u)}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50"
                    >
                      <span>
                        <span className="font-medium">{u.email}</span>
                        <span className="block text-xs text-slate-500">{u.fullName ?? '—'}</span>
                      </span>
                      <span className="text-slate-600">{tl(u.balanceKurus)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3 text-sm">
              <span>
                <span className="font-semibold">{customer.email}</span>
                <span className="block text-xs text-slate-500">
                  {customer.fullName ?? '—'} · bakiye {tl(customer.balanceKurus)}
                </span>
              </span>
              <Button small variant="secondary" onClick={() => setCustomer(null)}>
                Değiştir
              </Button>
            </div>
            <Field
              label="Alınan nakit (₺)"
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setConfirming(false);
              }}
              placeholder="100"
              autoFocus
            />
            {submit.error && <Alert>{submit.error}</Alert>}
            {!confirming ? (
              <Button disabled={!amountKurus} onClick={() => setConfirming(true)}>
                Yükle
              </Button>
            ) : (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
                <p className="mb-2 font-semibold">
                  {customer.email} hesabına {tl(amountKurus ?? 0)} yüklenecek. Nakdi aldınız mı?
                </p>
                <div className="flex gap-2">
                  <Button busy={submit.busy} onClick={doTopUp}>
                    Evet, yükle
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirming(false)}>
                    Vazgeç
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function ReportCard({
  stations,
  stationId,
  version,
}: {
  stations: AdminStation[];
  stationId: string;
  version: number;
}) {
  const [date, setDate] = useState(istanbulToday);
  const report = useLoad(
    () =>
      stationId
        ? api<CashReport>(`/admin/reports/cash?date=${date}&stationId=${stationId}`)
        : Promise.resolve(null),
    [date, stationId, version],
  );
  const r = report.data;
  const stationName = stations.find((s) => s.id === stationId)?.name ?? '';

  return (
    <Card title="Gün sonu kasa raporu">
      <div className="mb-4 flex items-end gap-3">
        <Field
          label="Gün (İstanbul saati)"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <p className="pb-2 text-sm text-slate-600">{stationName}</p>
      </div>
      {report.error && <Alert>{report.error}</Alert>}
      {report.loading && !r && <Loading />}
      {r && (
        <>
          <div className="mb-4 grid grid-cols-3 gap-3 text-center">
            <Stat label="Nakit giriş" value={tl(r.totalTopUpKurus)} />
            <Stat label="Kasadan iade" value={tl(r.totalCashRefundKurus)} />
            <Stat label="Kasada olmalı" value={tl(r.expectedCashKurus)} strong />
          </div>
          {r.byOperator.length === 0 ? (
            <Empty>Bu gün nakit hareketi yok.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={TH}>Operatör</th>
                  <th className={TH}>Yükleme</th>
                  <th className={TH}>Kasadan iade</th>
                </tr>
              </thead>
              <tbody>
                {r.byOperator.map((o) => (
                  <tr key={o.operatorId}>
                    <td className={TD}>{o.operatorEmail ?? o.operatorId}</td>
                    <td className={TD}>
                      {tl(o.topUpKurus)} <Badge>{o.topUpCount} işlem</Badge>
                    </td>
                    <td className={TD}>
                      {o.cashRefundCount > 0 ? (
                        <>
                          {tl(o.cashRefundKurus)} <Badge>{o.cashRefundCount} işlem</Badge>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </>
      )}
    </Card>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`rounded-lg p-3 ${strong ? 'bg-brand-50' : 'bg-slate-50'}`}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-lg ${strong ? 'font-bold' : 'font-semibold'}`}>{value}</p>
    </div>
  );
}
