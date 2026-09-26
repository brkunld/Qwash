'use client';

import type { AdminUserSummary } from '@qwash/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Field,
  PageHeader,
  Table,
  TD,
  TH,
} from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, tl } from '@/lib/format';
import { useAction } from '@/lib/hooks';

const STATUS_TONE = { ACTIVE: 'green', SUSPENDED: 'amber', DELETED: 'red' } as const;
const STATUS_LABEL = { ACTIVE: 'Aktif', SUSPENDED: 'Askıda', DELETED: 'Silinmiş' } as const;

export default function UsersPage() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<AdminUserSummary[] | null>(null);
  const search = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = await search.run(() =>
      api<AdminUserSummary[]>(`/admin/users?q=${encodeURIComponent(q)}`),
    );
    if (found) setResults(found);
  }

  return (
    <>
      <PageHeader
        title="Kullanıcılar"
        subtitle="E-posta, ad soyad veya kullanıcı kimliğiyle arayın (en az 2 karakter)."
      />
      <Card className="mb-4">
        <form onSubmit={submit} className="flex items-end gap-3">
          <Field
            className="flex-1"
            label="Ara"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ornek@eposta.com"
            minLength={2}
            required
            autoFocus
          />
          <Button type="submit" busy={search.busy}>
            Ara
          </Button>
        </form>
      </Card>
      {search.error && <Alert>{search.error}</Alert>}
      {results && (
        <Card>
          {results.length === 0 ? (
            <Empty>Eşleşen kullanıcı yok.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={TH}>Kullanıcı</th>
                  <th className={TH}>Durum</th>
                  <th className={TH}>Bakiye</th>
                  <th className={TH}>Kayıt</th>
                </tr>
              </thead>
              <tbody>
                {results.map((u) => (
                  <tr key={u.id}>
                    <td className={TD}>
                      <Link
                        href={`/users/${u.id}`}
                        className="font-medium text-brand-700 underline"
                      >
                        {u.email}
                      </Link>
                      <div className="text-xs text-slate-500">{u.fullName ?? 'Ad girilmemiş'}</div>
                    </td>
                    <td className={TD}>
                      <Badge tone={STATUS_TONE[u.status]}>{STATUS_LABEL[u.status]}</Badge>{' '}
                      {u.role !== 'USER' && <Badge tone="blue">{u.role}</Badge>}
                    </td>
                    <td className={TD}>
                      {tl(u.balanceKurus)}
                      {u.holdKurus > 0 && (
                        <div className="text-xs text-slate-500">bloke {tl(u.holdKurus)}</div>
                      )}
                    </td>
                    <td className={TD}>{dateTime(u.createdAt)}</td>
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
