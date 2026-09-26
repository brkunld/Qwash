'use client';

import type { AdminSessionView } from '@qwash/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Field } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, durationLabel, parseTl, tl } from '@/lib/format';
import { useAction } from '@/lib/hooks';

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

/** Seans ozeti, inceleme kapatma (isaretliyse) ve teknik hata iadesi. */
export function SessionCard({
  session: s,
  onChanged,
}: {
  session: AdminSessionView;
  onChanged: () => Promise<void>;
}) {
  const flagged = [...new Set(s.transitions.map((t) => t.reason))].filter((r) => REASON_HELP[r]);

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
            </Link>{' '}
            ·{' '}
            <Link href={`/sessions/${s.id}`} className="underline">
              seans
            </Link>
          </p>
        </div>
        <div className="flex gap-1.5">
          <Badge tone={s.status === 'COMPLETED' ? 'green' : 'blue'}>{s.status}</Badge>
          {s.reviewedAt && <Badge tone="slate">İncelendi</Badge>}
          {s.serviceRefund && <Badge tone="amber">İade edildi</Badge>}
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

      {s.needsReview && <ReviewForm session={s} onChanged={onChanged} />}
      <ServiceRefund session={s} onChanged={onChanged} />
    </Card>
  );
}

function ReviewForm({
  session: s,
  onChanged,
}: {
  session: AdminSessionView;
  onChanged: () => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const action = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const res = await action.run(() =>
      api(`/admin/sessions/${s.id}/review`, { method: 'POST', body: { note } }),
    );
    if (res !== undefined) await onChanged();
  }

  if (s.reviewedAt) {
    return (
      <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">
        <span className="font-semibold">İnceleme notu:</span> {s.reviewNote}
      </p>
    );
  }
  return (
    <>
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
      {action.error && (
        <div className="mt-2">
          <Alert>{action.error}</Alert>
        </div>
      )}
    </>
  );
}

/**
 * Teknik hata iadesi: tutar karta degil musterinin bakiyesine doner, seans basina bir kez.
 * Tutar bos birakilirsa tahsil edilenin tamami iade edilir.
 */
function ServiceRefund({
  session: s,
  onChanged,
}: {
  session: AdminSessionView;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const action = useAction();
  const charged = s.chargedKurus ?? 0;

  if (s.serviceRefund) {
    return (
      <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm">
        <span className="font-semibold">Teknik hata iadesi:</span> {tl(s.serviceRefund.amountKurus)}{' '}
        bakiyeye yazıldı ({dateTime(s.serviceRefund.at)}). {s.serviceRefund.note}
      </p>
    );
  }
  if (s.status !== 'COMPLETED' || charged <= 0) return null;
  if (!open) {
    return (
      <div className="mt-3">
        <Button variant="secondary" small onClick={() => setOpen(true)}>
          Teknik hata iadesi
        </Button>
      </div>
    );
  }

  const partial = amount.trim() === '' ? null : parseTl(amount);
  const invalid = amount.trim() !== '' && (partial === null || partial <= 0 || partial > charged);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid) return;
    const res = await action.run(() =>
      api(`/admin/sessions/${s.id}/service-refund`, {
        method: 'POST',
        body: { reason, ...(partial ? { amountKurus: partial } : {}) },
      }),
    );
    if (res !== undefined) await onChanged();
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-3 rounded-lg border p-3">
      <p className="text-xs text-slate-600">
        Tutar müşterinin <strong>bakiyesine</strong> döner (karta değil). Seans başına yalnız bir
        kez yapılabilir. Tahsil edilen: {tl(charged)}.
      </p>
      <Field
        label="Tutar (₺, boş = tamamı)"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder={tl(charged)}
      />
      <Field
        label="Gerekçe (en az 10 karakter)"
        hint="Örn: Peron su vermedi, pompa arızası."
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        minLength={10}
        maxLength={500}
        required
      />
      {invalid && <Alert>Tutar 0&apos;dan büyük ve en fazla {tl(charged)} olmalı.</Alert>}
      {action.error && <Alert>{action.error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" busy={action.busy} disabled={invalid}>
          Bakiyeye iade et
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Vazgeç
        </Button>
      </div>
    </form>
  );
}
