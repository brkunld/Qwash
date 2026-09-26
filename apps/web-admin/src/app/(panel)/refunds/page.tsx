'use client';

import type { AdminRefundRequest } from '@qwash/contracts';
import Link from 'next/link';
import { useState } from 'react';
import {
  Alert,
  Badge,
  Card,
  Empty,
  Loading,
  PageHeader,
  Select,
  Table,
  TD,
  TH,
} from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, tl } from '@/lib/format';
import { useLoad } from '@/lib/hooks';
import { REASON_LABEL, REQUEST_LABEL, REQUEST_TONE } from '@/lib/labels';

export default function RefundsPage() {
  const [status, setStatus] = useState<'REQUESTED' | 'COMPLETED' | 'REJECTED' | ''>('REQUESTED');
  const list = useLoad(
    () => api<AdminRefundRequest[]>(`/admin/refund-requests${status ? `?status=${status}` : ''}`),
    [status],
  );

  return (
    <>
      <PageHeader
        title="İade talepleri"
        subtitle="Bakiyedeki para bloke edilmiş durumda bekler. Parçaları tek tek ödeyin; son parça ödenince talep kapanır."
      />
      <Card className="mb-4">
        <Select
          label="Durum"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          className="max-w-xs"
        >
          <option value="REQUESTED">Bekleyenler</option>
          <option value="COMPLETED">Tamamlananlar</option>
          <option value="REJECTED">Reddedilenler</option>
          <option value="">Hepsi</option>
        </Select>
      </Card>
      {list.error && <Alert>{list.error}</Alert>}
      {list.loading && !list.data && <Loading />}
      {list.data && (
        <Card>
          {list.data.length === 0 ? (
            <Empty>Bu durumda talep yok.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={TH}>Talep</th>
                  <th className={TH}>Neden</th>
                  <th className={TH}>Tutar</th>
                  <th className={TH}>Parçalar</th>
                  <th className={TH}>Durum</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((r) => (
                  <tr key={r.id}>
                    <td className={TD}>
                      <Link
                        href={`/refunds/${r.id}`}
                        className="font-medium text-brand-700 underline"
                      >
                        {r.holderName || 'İsimsiz'}
                      </Link>
                      <div className="text-xs text-slate-500">{dateTime(r.createdAt)}</div>
                    </td>
                    <td className={TD}>{REASON_LABEL[r.reason]}</td>
                    <td className={TD}>{tl(r.amountKurus)}</td>
                    <td className={TD}>
                      {r.payouts.length === 0
                        ? '—'
                        : `${r.payouts.filter((p) => p.status === 'DONE').length}/${r.payouts.length} ödendi`}
                    </td>
                    <td className={TD}>
                      <Badge tone={REQUEST_TONE[r.status]}>{REQUEST_LABEL[r.status]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
