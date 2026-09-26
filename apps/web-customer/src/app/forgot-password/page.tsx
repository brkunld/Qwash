'use client';

import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, Page } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api<void>('/auth/forgot-password', { method: 'POST', body: { email }, auth: false });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Şifremi unuttum" back="/login">
      <Card>
        {done ? (
          // Sunucu hesabin var olup olmadigini soylemez; mesaj da soylememeli.
          <Alert tone="info">
            Bu e-postaya kayıtlı bir hesap varsa şifre sıfırlama bağlantısı gönderildi.
          </Alert>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            {error && <Alert>{error}</Alert>}
            <Field
              label="E-posta"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button type="submit" busy={busy}>
              Sıfırlama bağlantısı gönder
            </Button>
          </form>
        )}
      </Card>
    </Page>
  );
}
