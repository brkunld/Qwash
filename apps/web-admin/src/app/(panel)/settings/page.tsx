'use client';

import type { TopUpSettingsView } from '@qwash/contracts';
import { useState, type FormEvent } from 'react';
import { useIsSuper } from '@/components/shell';
import { Alert, Button, Card, Field, Loading, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime, parseTl, tl } from '@/lib/format';
import { useAction, useLoad } from '@/lib/hooks';

export default function SettingsPage() {
  const isSuper = useIsSuper();
  const settings = useLoad(() => api<TopUpSettingsView>('/admin/settings/topup'), []);
  // null: kullanici henuz dokunmadi, sunucudaki deger gosterilir.
  const [minEdit, setMin] = useState<string | null>(null);
  const [maxEdit, setMax] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const s = settings.data;

  const min = minEdit ?? (s ? String(s.minTopUpKurus / 100) : '');
  const max = maxEdit ?? (s ? String(s.maxTopUpKurus / 100) : '');

  const minKurus = parseTl(min);
  const maxKurus = parseTl(max);
  const valid = minKurus !== null && maxKurus !== null && minKurus >= 100 && maxKurus >= minKurus;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setSaved(false);
    const res = await action.run(() =>
      api<TopUpSettingsView>('/admin/settings/topup', {
        method: 'PUT',
        body: { minTopUpKurus: minKurus, maxTopUpKurus: maxKurus },
      }),
    );
    if (res) {
      setSaved(true);
      setMin(null);
      setMax(null);
      await settings.reload();
    }
  }

  return (
    <>
      <PageHeader title="Ayarlar" subtitle="Bakiye yükleme sınırları." />
      {settings.error && <Alert>{settings.error}</Alert>}
      {settings.loading && !s && <Loading />}
      {s && (
        <Card title="Bakiye yükleme" className="max-w-lg">
          {!isSuper && (
            <div className="mb-3">
              <Alert tone="info">Bu ayarları yalnız süper yönetici değiştirebilir.</Alert>
            </div>
          )}
          <p className="mb-4 text-sm text-slate-600">
            Müşteriye hazır tutarlar minimumun 1, 2 ve 4 katı olarak sunulur (üst sınırı aşanlar
            çıkarılır). Şu an: {tl(s.minTopUpKurus)} – {tl(s.maxTopUpKurus)}, son değişiklik{' '}
            {dateTime(s.updatedAt)}. Ayarlar hem kartla hem kasada nakit yüklemeye uygulanır (üst
            sınır).
          </p>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field
              label="Minimum yükleme (₺)"
              hint="En az 1 ₺."
              inputMode="decimal"
              value={min}
              onChange={(e) => setMin(e.target.value)}
              disabled={!isSuper}
            />
            <Field
              label="Üst sınır (₺)"
              inputMode="decimal"
              value={max}
              onChange={(e) => setMax(e.target.value)}
              disabled={!isSuper}
            />
            {valid && minKurus !== null && (
              <p className="text-sm text-slate-600">
                Hazır tutarlar: {[1, 2, 4].map((m) => tl(m * minKurus)).join(' · ')}
              </p>
            )}
            {action.error && <Alert>{action.error}</Alert>}
            {saved && <Alert tone="success">Kaydedildi.</Alert>}
            <Button type="submit" busy={action.busy} disabled={!isSuper || !valid}>
              Kaydet
            </Button>
          </form>
        </Card>
      )}
    </>
  );
}
