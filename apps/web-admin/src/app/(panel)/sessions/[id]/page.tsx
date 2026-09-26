'use client';

import type { AdminSessionView } from '@qwash/contracts';
import { useParams } from 'next/navigation';
import { SessionCard } from '@/components/session-card';
import { Alert, Loading, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { useLoad } from '@/lib/hooks';

/** Tek seans: musteri destek talebinde teknik hata iadesi buradan yapilir. */
export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const session = useLoad(() => api<AdminSessionView>(`/admin/sessions/${id}`), [id]);

  return (
    <>
      <PageHeader title="Seans" subtitle={id} />
      {session.error && <Alert>{session.error}</Alert>}
      {session.loading && !session.data && <Loading />}
      {session.data && (
        <div className="max-w-4xl">
          <SessionCard session={session.data} onChanged={session.reload} />
        </div>
      )}
    </>
  );
}
