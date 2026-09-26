'use client';

import type { AdminUserDetail, BalanceAdjustmentResult } from '@qwash/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useIsSuper } from '@/components/shell';
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
import { dateTime, parseTl, tl } from '@/lib/format';
import { useAction, useLoad } from '@/lib/hooks';

const LEDGER_TONE = {
  CREDIT: 'green',
  DEBIT: 'red',
  HOLD: 'amber',
  CAPTURE: 'slate',
  RELEASE: 'blue',
} as const;

const SOURCE_LABEL: Record<string, string> = {
  CARD_TOPUP: 'Kart yükleme',
  CASH_TOPUP: 'Nakit yükleme',
  SESSION: 'Yıkama',
  ADJUSTMENT: 'Manuel düzeltme',
  REFUND: 'İade',
  FORFEIT: 'Feragat',
  CASH_REFUND: 'Kasadan iade',
};

export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isSuper = useIsSuper();
  const user = useLoad(() => api<AdminUserDetail>(`/admin/users/${id}`), [id]);
  const u = user.data;

  return (
    <>
      <PageHeader
        title={u?.email ?? 'Kullanıcı'}
        subtitle={u?.fullName ?? undefined}
        actions={
          <Link href="/cash" className="text-sm font-semibold text-brand-700 underline">
            Nakit yükleme
          </Link>
        }
      />
      {user.error && <Alert>{user.error}</Alert>}
      {user.loading && !u && <Loading />}
      {u && (
        <div className="grid gap-4 xl:grid-cols-3">
          <div className="flex flex-col gap-4 xl:col-span-1">
            <Card title="Hesap">
              <dl className="grid grid-cols-2 gap-y-2 text-sm">
                <dt className="text-slate-500">Durum</dt>
                <dd>
                  <Badge tone={u.status === 'ACTIVE' ? 'green' : 'red'}>{u.status}</Badge>
                </dd>
                <dt className="text-slate-500">Rol</dt>
                <dd>{u.role}</dd>
                <dt className="text-slate-500">E-posta</dt>
                <dd>{u.emailVerified ? 'Doğrulanmış' : 'Doğrulanmamış'}</dd>
                <dt className="text-slate-500">Telefon</dt>
                <dd>{u.phoneNumber ?? '—'}</dd>
                <dt className="text-slate-500">Ad mühürlü</dt>
                <dd>{u.nameLockedAt ? dateTime(u.nameLockedAt) : 'Hayır'}</dd>
                <dt className="text-slate-500">Kayıt</dt>
                <dd>{dateTime(u.createdAt)}</dd>
              </dl>
            </Card>
            <Card title="Bakiye">
              <p className="text-3xl font-bold">{tl(u.balanceKurus - u.holdKurus)}</p>
              <p className="text-sm text-slate-500">
                kullanılabilir · toplam {tl(u.balanceKurus)}
                {u.holdKurus > 0 && ` · bloke ${tl(u.holdKurus)}`}
              </p>
            </Card>
            {isSuper && u.status !== 'DELETED' && (
              <AdjustmentForm userId={u.id} onDone={user.reload} />
            )}
          </div>
          <Card title="Son hareketler (50)" className="xl:col-span-2">
            {u.ledger.length === 0 ? (
              <Empty>Hareket yok.</Empty>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th className={TH}>Tarih</th>
                    <th className={TH}>İşlem</th>
                    <th className={TH}>Tutar</th>
                    <th className={TH}>Bakiye</th>
                    <th className={TH}>Not</th>
                  </tr>
                </thead>
                <tbody>
                  {u.ledger.map((e) => (
                    <tr key={e.id}>
                      <td className={TD}>{dateTime(e.createdAt)}</td>
                      <td className={TD}>
                        <Badge tone={LEDGER_TONE[e.type]}>{e.type}</Badge>{' '}
                        <span className="text-xs text-slate-600">
                          {SOURCE_LABEL[e.source] ?? e.source}
                        </span>
                      </td>
                      <td className={TD}>{tl(e.amountKurus)}</td>
                      <td className={TD}>{tl(e.balanceAfterKurus)}</td>
                      <td className={`${TD} max-w-xs text-xs text-slate-600`}>{e.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

/**
 * Manuel bakiye duzeltme (yalniz SUPER_ADMIN). Idempotency-Key form bir kez acildiginda
 * uretilir; ayni form iki kez gonderilirse ikinci istek ayni sonucu doner (cift tiklama).
 * Basarili islemden sonra yeni anahtar uretilir.
 */
function AdjustmentForm({ userId, onDone }: { userId: string; onDone: () => Promise<void> }) {
  const [direction, setDirection] = useState<'CREDIT' | 'DEBIT'>('CREDIT');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(newIdempotencyKey);
  const [done, setDone] = useState<string | null>(null);
  const action = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const amountKurus = parseTl(amount);
    if (!amountKurus || amountKurus <= 0) return;
    setDone(null);
    const res = await action.run(() =>
      api<BalanceAdjustmentResult>(`/admin/users/${userId}/adjustments`, {
        method: 'POST',
        idempotencyKey: key,
        body: { direction, amountKurus, reason },
      }),
    );
    if (res) {
      setDone(`Düzeltme yazıldı. Yeni bakiye: ${tl(res.balanceAfterKurus)}`);
      setAmount('');
      setReason('');
      setKey(newIdempotencyKey());
      await onDone();
    }
  }

  return (
    <Card title="Manuel bakiye düzeltme">
      <p className="mb-3 text-xs text-slate-600">
        Yalnız hata düzeltmek için. Nakit yükleme için{' '}
        <Link href="/cash" className="underline">
          Kasa
        </Link>{' '}
        sayfasını kullanın. İşlem gerekçesiyle birlikte denetim kaydına yazılır.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Select
          label="Yön"
          value={direction}
          onChange={(e) => setDirection(e.target.value as 'CREDIT' | 'DEBIT')}
        >
          <option value="CREDIT">Bakiyeye ekle</option>
          <option value="DEBIT">Bakiyeden düş</option>
        </Select>
        <Field
          label="Tutar (₺)"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="12,50"
          required
        />
        <Field
          label="Gerekçe (en az 10 karakter)"
          hint="Örn: Seans 1234 çift tahsil edildi, fark iade."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          minLength={10}
          maxLength={500}
          required
        />
        {action.error && <Alert>{action.error}</Alert>}
        {done && <Alert tone="success">{done}</Alert>}
        <Button type="submit" busy={action.busy} disabled={parseTl(amount) === null}>
          Düzeltmeyi yaz
        </Button>
      </form>
    </Card>
  );
}
