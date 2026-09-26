'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, LinkButton, Loading, Page } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';

function ResetForm() {
  const token = useSearchParams().get('token');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api<void>('/auth/reset-password', {
        method: 'POST',
        body: { token, password },
        auth: false,
      });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!token)
    return <Alert>Sıfırlama bağlantısı eksik. E-postadaki bağlantıyı yeniden açın.</Alert>;
  if (done) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="success">Şifreniz değişti. Tüm cihazlardaki oturumlar kapatıldı.</Alert>
        <LinkButton href="/login">Giriş yap</LinkButton>
      </div>
    );
  }
  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && <Alert>{error}</Alert>}
        <Field
          label="Yeni şifre"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={72}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="En az 8 karakter."
        />
        <Button type="submit" busy={busy}>
          Şifreyi değiştir
        </Button>
      </form>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <Page title="Yeni şifre">
      <Suspense fallback={<Loading />}>
        <ResetForm />
      </Suspense>
    </Page>
  );
}
