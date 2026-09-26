'use client';

import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, Loading } from '@/components/ui';
import { login, safeNext, useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';

function LoginForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
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
      </form>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 p-6">
      <div className="flex flex-col items-center gap-2">
        <Image src="/logo.png" alt="QWash" width={120} height={34} priority />
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Admin paneli</p>
      </div>
      <Suspense fallback={<Loading />}>
        <LoginForm />
      </Suspense>
      <p className="text-center text-xs text-slate-500">
        Yönetici hesabı için PWA&apos;dan kayıt olup <code>pnpm admin:grant</code> ile yetki verin.
      </p>
    </main>
  );
}
