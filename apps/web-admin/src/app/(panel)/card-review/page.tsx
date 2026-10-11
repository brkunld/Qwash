'use client';

import type { AdminCardTopUpReview } from '@qwash/contracts';
import { useState } from 'react';
import {
  Alert,
  Badge,
  Card,
  ConfirmButton,
  Empty,
  Field,
  Loading,
  PageHeader,
  Table,
  TD,
  TH,
} from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, tl } from '@/lib/format';
import { useAction, useLoad } from '@/lib/hooks';

// Parasi cekilmis olabilir ama bakiyeye yazilmamis kart odemeleri (guvenlik incelemesi #3).
export default function CardReviewPage() {
  const list = useLoad(() => api<AdminCardTopUpReview[]>('/admin/card-topups/review'), []);

  return (
    <>
      <PageHeader
        title="Ödeme incelemesi"
        subtitle="Iyzico ödemeyi başarılı bildirdi ama tutar, sepet ya da fraud kontrolü tutmadığı için bakiye yüklenmedi. Müşterinin kartından para çekilmiş olabilir."
      />
      <div className="mb-4">
        <Alert tone="warning">
          Önce Iyzico panelinde ödeme numarasıyla işlemi bulun. Para çekildiyse karta iade edin.
          Bakiyeye yüklenmesi gerekiyorsa süper yönetici bakiye düzeltmesiyle yükler; bu ekrandan
          iade etmeyin.
        </Alert>
      </div>
      {list.error && <Alert>{list.error}</Alert>}
      {list.loading && !list.data && <Loading />}
      {list.data && (
        <Card>
          {list.data.length === 0 ? (
            <Empty>İncelemede ödeme yok.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={TH}>Müşteri</th>
                  <th className={TH}>Tutar</th>
                  <th className={TH}>Neden</th>
                  <th className={TH}>Iyzico ödeme no</th>
                  <th className={TH}>İşlem</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((t) => (
                  <ReviewRow key={t.id} topUp={t} onChanged={list.reload} />
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </>
  );
}

function ReviewRow({
  topUp: t,
  onChanged,
}: {
  topUp: AdminCardTopUpReview;
  onChanged: () => Promise<void>;
}) {
  const action = useAction();
  const [reason, setReason] = useState('');
  const pending = t.status === 'REVERSAL_PENDING';

  async function reverse() {
    const res = await action.run(() =>
      api(`/admin/card-topups/${t.id}/reverse`, { method: 'POST', body: { reason } }),
    );
    if (res !== undefined) await onChanged();
  }

  return (
    <tr>
      <td className={TD}>
        <div className="font-medium">{t.userEmail}</div>
        <div className="text-xs text-ink-muted">{dateTime(t.createdAt)}</div>
      </td>
      <td className={TD}>{tl(t.amountKurus)}</td>
      <td className={TD}>{t.reason}</td>
      <td className={TD}>
        <code className="select-all">{t.iyzicoPaymentId ?? '-'}</code>
      </td>
      <td className={TD}>
        {pending ? (
          <Badge tone="amber">İade gönderiliyor</Badge>
        ) : (
          <div className="flex min-w-64 flex-col gap-2">
            <Field
              label="Gerekçe (en az 10 karakter)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {reason.trim().length >= 10 && (
              <ConfirmButton
                label="Karta iade et"
                confirmLabel={`Evet, ${tl(t.amountKurus)} karta iade et`}
                busy={action.busy}
                onConfirm={() => void reverse()}
              />
            )}
            {action.error && <Alert>{action.error}</Alert>}
          </div>
        )}
      </td>
    </tr>
  );
}
