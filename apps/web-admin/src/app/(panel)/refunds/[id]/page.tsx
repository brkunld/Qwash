'use client';

import type {
  AdminRefundRequest,
  AdminStation,
  RefundPayoutView,
  ResolvePayoutRequest,
} from '@qwash/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmButton,
  Field,
  Loading,
  PageHeader,
  Select,
} from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, tl } from '@/lib/format';
import { useAction, useLoad } from '@/lib/hooks';
import {
  METHOD_LABEL,
  PAYOUT_LABEL,
  PAYOUT_TONE,
  REASON_LABEL,
  REQUEST_LABEL,
  REQUEST_TONE,
} from '@/lib/labels';

export default function RefundDetailPage() {
  const { id } = useParams<{ id: string }>();
  const req = useLoad(() => api<AdminRefundRequest>(`/admin/refund-requests/${id}`), [id]);
  const stations = useLoad(() => api<AdminStation[]>('/admin/stations'), []);
  const r = req.data;

  return (
    <>
      <PageHeader
        title={r ? `İade: ${r.holderName || 'İsimsiz'}` : 'İade talebi'}
        subtitle={
          r
            ? `${REASON_LABEL[r.reason]} · ${tl(r.amountKurus)} · ${dateTime(r.createdAt)}`
            : undefined
        }
        actions={
          <Link href="/refunds" className="text-sm font-semibold text-brand-700 underline">
            ← Listeye dön
          </Link>
        }
      />
      {req.error && <Alert>{req.error}</Alert>}
      {req.loading && !r && <Loading />}
      {r && (
        <div className="flex max-w-3xl flex-col gap-4">
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={REQUEST_TONE[r.status]}>{REQUEST_LABEL[r.status]}</Badge>
              {r.resolvedAt && (
                <span className="text-sm text-slate-600">{dateTime(r.resolvedAt)}</span>
              )}
            </div>
            <dl className="mt-3 grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
              <dt className="text-slate-500">Mühürlü ad soyad</dt>
              <dd className="font-semibold">{r.holderName || '—'}</dd>
              <dt className="text-slate-500">İletişim e-postası</dt>
              <dd>{r.contactEmail ?? 'temizlendi'}</dd>
              <dt className="text-slate-500">Müşteri</dt>
              <dd>
                <Link href={`/users/${r.userId}`} className="underline">
                  {r.userId}
                </Link>
              </dd>
              {r.rejectReason && (
                <>
                  <dt className="text-slate-500">Red gerekçesi</dt>
                  <dd>{r.rejectReason}</dd>
                </>
              )}
            </dl>
          </Card>

          {r.payouts.map((p) => (
            <PayoutCard
              key={p.partIndex}
              request={r}
              payout={p}
              stations={stations.data ?? []}
              onChanged={req.reload}
            />
          ))}

          {r.status === 'REQUESTED' && <RejectCard request={r} onChanged={req.reload} />}
        </div>
      )}
    </>
  );
}

function PayoutCard({
  request,
  payout: p,
  stations,
  onChanged,
}: {
  request: AdminRefundRequest;
  payout: RefundPayoutView;
  stations: AdminStation[];
  onChanged: () => Promise<void>;
}) {
  const action = useAction();
  const [reference, setReference] = useState('');
  const [stationId, setStationId] = useState('');
  const [reason, setReason] = useState('');
  const open = request.status === 'REQUESTED';
  const base = `/admin/refund-requests/${request.id}/payouts/${p.partIndex}`;

  async function call(path: string, body?: ResolvePayoutRequest) {
    const res = await action.run(() => api(base + path, { method: 'POST', body }));
    if (res !== undefined) {
      setReference('');
      setReason('');
      await onChanged();
    }
  }

  function markPaid(e: FormEvent) {
    e.preventDefault();
    void call('/resolve', {
      outcome: 'PAID',
      reference,
      ...(p.method === 'CASH_AT_STATION' ? { stationId: stationId || stations[0]?.id } : {}),
    });
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          Parça {p.partIndex + 1}: {METHOD_LABEL[p.method]}
        </h2>
        <span className="flex items-center gap-2">
          <span className="text-lg font-bold">{tl(p.amountKurus)}</span>
          <Badge tone={PAYOUT_TONE[p.status]}>{PAYOUT_LABEL[p.status]}</Badge>
        </span>
      </div>
      {p.reference && (
        <p className="mt-1 text-sm text-slate-600">
          Referans: <code>{p.reference}</code> · {dateTime(p.completedAt)}
        </p>
      )}
      {p.failureReason && <p className="mt-1 text-sm text-red-700">Not: {p.failureReason}</p>}
      {action.error && (
        <div className="mt-3">
          <Alert>{action.error}</Alert>
        </div>
      )}

      {open && p.method === 'CARD' && (p.status === 'PENDING' || p.status === 'FAILED') && (
        <div className="mt-3">
          <p className="mb-2 text-sm text-slate-600">
            Iyzico&apos;dan orijinal kart işlemine kısmi iade yapılır. İade sonucu belirsiz kalırsa
            tekrar denenmez; siz Iyzico panelinden kontrol edersiniz.
          </p>
          <ConfirmButton
            label="Iyzico ile karta iade et"
            confirmLabel={`Evet, ${tl(p.amountKurus)} iade et`}
            variant="primary"
            busy={action.busy}
            onConfirm={() => void call('/card-refund')}
          />
        </div>
      )}

      {open && p.method === 'CARD' && p.status === 'IN_FLIGHT' && (
        <div className="mt-3 flex flex-col gap-3">
          <Alert tone="warning">
            İade isteği Iyzico&apos;ya gönderildi ama sonuç kaydedilemedi.{' '}
            <strong>Tekrar göndermeyin:</strong> önce Iyzico merchant panelinden bu işlemin iade
            durumuna bakın.
          </Alert>
          <form onSubmit={markPaid} className="flex items-end gap-2">
            <Field
              className="flex-1"
              label="Panelde iade GÖRÜNÜYOR: Iyzico iade referansı"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              minLength={3}
              required
            />
            <Button type="submit" busy={action.busy}>
              Ödendi işaretle
            </Button>
          </form>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void call('/resolve', { outcome: 'NOT_PAID', reason });
            }}
            className="flex items-end gap-2"
          >
            <Field
              className="flex-1"
              label="Panelde iade YOK: gerekçe (en az 10 karakter)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={10}
              required
            />
            <Button type="submit" variant="secondary" busy={action.busy}>
              Yeniden denenebilir yap
            </Button>
          </form>
        </div>
      )}

      {open && p.method === 'IBAN' && p.status !== 'DONE' && (
        <div className="mt-3 flex flex-col gap-3">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 rounded-lg bg-slate-50 p-3 text-sm">
            <dt className="text-slate-500">IBAN</dt>
            <dd>
              <code className="select-all">{request.iban}</code>
            </dd>
            <dt className="text-slate-500">Alıcı adı</dt>
            <dd className="font-semibold">{request.holderName}</dd>
            <dt className="text-slate-500">Açıklama</dt>
            <dd>
              <code className="select-all">{request.transferDescription}</code>
            </dd>
          </dl>
          <Alert tone="warning">
            EFT&apos;den önce bankanın gösterdiği alıcı adını yukarıdaki mühürlü adla{' '}
            <strong>gözle karşılaştırın</strong>. Uyuşmuyorsa göndermeyin, talebi reddedin.
          </Alert>
          <form onSubmit={markPaid} className="flex items-end gap-2">
            <Field
              className="flex-1"
              label="EFT dekont numarası"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              minLength={3}
              required
            />
            <Button type="submit" busy={action.busy}>
              Gönderildi işaretle
            </Button>
          </form>
        </div>
      )}

      {open && p.method === 'CASH_AT_STATION' && p.status !== 'DONE' && (
        <form onSubmit={markPaid} className="mt-3 flex flex-wrap items-end gap-2">
          <Select
            label="Kasa (istasyon)"
            value={stationId || stations[0]?.id || ''}
            onChange={(e) => setStationId(e.target.value)}
          >
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Field
            className="min-w-48 flex-1"
            label="Kasa fişi / not"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            minLength={3}
            required
          />
          <Button type="submit" busy={action.busy}>
            Kasadan ödendi
          </Button>
        </form>
      )}
    </Card>
  );
}

function RejectCard({
  request,
  onChanged,
}: {
  request: AdminRefundRequest;
  onChanged: () => Promise<void>;
}) {
  const [show, setShow] = useState(false);
  const [reason, setReason] = useState('');
  const action = useAction();
  const blocked = request.payouts.some((p) => p.status === 'DONE' || p.status === 'IN_FLIGHT');

  async function reject(e: FormEvent) {
    e.preventDefault();
    const res = await action.run(() =>
      api(`/admin/refund-requests/${request.id}/reject`, { method: 'POST', body: { reason } }),
    );
    if (res !== undefined) await onChanged();
  }

  return (
    <Card title="Talebi reddet">
      {blocked ? (
        <p className="text-sm text-slate-600">
          Ödenmiş veya sonucu belirsiz parça olduğu için reddedilemez.
        </p>
      ) : !show ? (
        <Button variant="secondary" small onClick={() => setShow(true)}>
          Reddet…
        </Button>
      ) : (
        <form onSubmit={reject} className="flex flex-col gap-3">
          <p className="text-sm text-slate-600">
            Bloke serbest kalır, tutar müşteri bakiyesine döner (hesap silinmişse erişilemez; önce
            durumu değerlendirin).
          </p>
          <Field
            label="Red gerekçesi (en az 10 karakter)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={10}
            maxLength={500}
            required
          />
          {action.error && <Alert>{action.error}</Alert>}
          <div className="flex gap-2">
            <Button type="submit" variant="danger" busy={action.busy}>
              Reddet
            </Button>
            <Button variant="secondary" onClick={() => setShow(false)}>
              Vazgeç
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
