'use client';

import type { AdminSessionView } from '@qwash/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Empty, Field, Loading, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, durationLabel, tl } from '@/lib/format';
import { useAction, useLoad } from '@/lib/hooks';

/** Gecis nedenlerinin operator icin anlami; bilinmeyen neden oldugu gibi gosterilir. */
const REASON_HELP: Record<string, string> = {
  DEVICE_LOST:
    'Cihaz beklenen sürede dönmedi; yalnız kanıtlanmış süre tahsil edildi, kalan iade edildi.',
  LATE_END_AFTER_AUTO_CLOSE:
    'Otomatik kapatıldıktan sonra cihaz gerçek bitişi bildirdi (para hareket etmedi).',
  UNPAID_RUN_REPORTED:
    'Bloke iade edilmişken cihaz çalıştığını bildirdi: ücretsiz kullanım olmuş olabilir.',
  DEVICE_DRIFT: 'Cihaz ile backend arasında uyuşmazlık tespit edildi.',
  LATE_ACK_STOP_SENT: 'Geç onay geldi; iade edilmiş seans için STOP gönderildi.',
  ADMIN_STOP_REQUESTED: 'Yönetici durdurdu.',
};

export default function ReviewPage() {
  const [all, setAll] = useState(false);
  const list = useLoad(
    () => api<AdminSessionView[]>(`/admin/sessions/review${all ? '?all=true' : ''}`),
    [all],
    15000,
  );

  return (
    <>
      <PageHeader
        title="İnceleme"
        subtitle="Sistemin şüpheli işaretlediği seanslar: kaybolan cihaz, ücretsiz çalışma, tahsilat tavanı. İnceledikten sonra kapatın; para hareketi gerekiyorsa süper yönetici bakiye düzeltmesi yapar."
        actions={
          <Button variant="secondary" small onClick={() => setAll((v) => !v)}>
            {all ? 'Yalnız incelenmemişler' : 'İncelenenleri de göster'}
          </Button>
        }
      />
      {list.error && <Alert>{list.error}</Alert>}
      {list.loading && !list.data && <Loading />}
      {list.data?.length === 0 && (
        <Card>
          <Empty>İncelenecek seans yok.</Empty>
        </Card>
      )}
      <div className="flex max-w-4xl flex-col gap-4">
        {list.data?.map((s) => (
          <ReviewCard key={s.id} session={s} onChanged={list.reload} />
        ))}
      </div>
    </>
  );
}

function ReviewCard({
  session: s,
  onChanged,
}: {
  session: AdminSessionView;
  onChanged: () => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const action = useAction();
  const flagged = [...new Set(s.transitions.map((t) => t.reason))].filter((r) => REASON_HELP[r]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const res = await action.run(() =>
      api(`/admin/sessions/${s.id}/review`, { method: 'POST', body: { note } }),
    );
    if (res !== undefined) await onChanged();
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">
            {s.bayCode} · {s.programCode} · {durationLabel(s.plannedDurationSec)}
          </h2>
          <p className="text-xs text-slate-500">
            {dateTime(s.createdAt)} ·{' '}
            <Link href={`/users/${s.userId}`} className="underline">
              {s.userEmail}
            </Link>
          </p>
        </div>
        <div className="flex gap-1.5">
          <Badge tone={s.status === 'COMPLETED' ? 'green' : 'blue'}>{s.status}</Badge>
          {s.reviewedAt && <Badge tone="slate">İncelendi</Badge>}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-slate-500">Kullanılan</dt>
          <dd>{s.usedSeconds === null ? '—' : durationLabel(s.usedSeconds)}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Kanıtlanmış</dt>
          <dd>{durationLabel(s.provenUsedSec)}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Tahsil edilen</dt>
          <dd>{s.chargedKurus === null ? '—' : tl(s.chargedKurus)}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Bitiş nedeni</dt>
          <dd>{s.endReason ?? '—'}</dd>
        </div>
      </dl>

      {flagged.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 text-sm text-amber-900">
          {flagged.map((r) => (
            <li key={r}>
              <strong>{r}:</strong> {REASON_HELP[r]}
            </li>
          ))}
        </ul>
      )}

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-slate-600">
          Seans geçmişi ({s.transitions.length})
        </summary>
        <ul className="mt-1 text-xs text-slate-600">
          {s.transitions.map((t, i) => (
            <li key={i}>
              {dateTime(t.at)} — {t.reason}
            </li>
          ))}
        </ul>
      </details>

      {s.reviewedAt ? (
        <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">
          <span className="font-semibold">İnceleme notu:</span> {s.reviewNote}
        </p>
      ) : (
        <form onSubmit={submit} className="mt-3 flex items-end gap-2">
          <Field
            className="flex-1"
            label="İnceleme notu (en az 10 karakter)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            minLength={10}
            maxLength={500}
            required
          />
          <Button type="submit" busy={action.busy}>
            İncelendi
          </Button>
        </form>
      )}
      {action.error && (
        <div className="mt-2">
          <Alert>{action.error}</Alert>
        </div>
      )}
    </Card>
  );
}
