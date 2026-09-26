'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, Loading, Page } from '@/components/ui';
import { login, safeNext, useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (auth.status === 'authenticated') router.replace(next);
  }, [auth.status, next, router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      router.replace(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (auth.status === 'loading') return <Loading />;

  return (
    <Card>
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
        <Field
          label="Şifre"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" busy={busy}>
          Giriş yap
        </Button>
        <div className="flex justify-between text-sm">
          <Link href="/forgot-password" className="text-sky-700">
            Şifremi unuttum
          </Link>
          <Link
            href={`/register?next=${encodeURIComponent(next)}`}
            className="font-semibold text-sky-700"
          >
            Hesap oluştur
          </Link>
        </div>
      </form>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <Page title="Giriş yap">
      <Suspense fallback={<Loading />}>
        <LoginForm />
      </Suspense>
    </Page>
  );
}
