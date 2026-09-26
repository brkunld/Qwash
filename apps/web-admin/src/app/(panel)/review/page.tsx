'use client';

import type { AdminSessionView } from '@qwash/contracts';
import { useState } from 'react';
import { SessionCard } from '@/components/session-card';
import { Alert, Button, Card, Empty, Loading, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { useLoad } from '@/lib/hooks';

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
        subtitle="Sistemin şüpheli işaretlediği seanslar: kaybolan cihaz, ücretsiz çalışma, tahsilat tavanı. İnceledikten sonra kapatın; müşteri hizmet alamadıysa teknik hata iadesiyle ücreti bakiyesine geri yazın."
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
          <SessionCard key={s.id} session={s} onChanged={list.reload} />
        ))}
      </div>
    </>
  );
}
