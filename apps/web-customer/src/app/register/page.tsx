'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, Loading, Page } from '@/components/ui';
import { register, safeNext } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';

function RegisterForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(fullName, email, password);
      router.replace(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && <Alert>{error}</Alert>}
        <Field
          label="Ad soyad"
          autoComplete="name"
          required
          minLength={2}
          maxLength={100}
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          hint="Kartla yüklemede ve olası iadelerde bu ad kullanılır."
        />
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
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={72}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="En az 8 karakter."
        />
        <p className="text-xs text-slate-500">
          Hesap oluşturarak{' '}
          <Link href="/legal/terms" className="underline">
            Kullanım Şartları
          </Link>
          &apos;nı kabul etmiş, kişisel verilerinizin{' '}
          <Link href="/legal/kvkk" className="underline">
            Aydınlatma Metni
          </Link>{' '}
          kapsamında işlenmesini okumuş olursunuz.
        </p>
        <Button type="submit" busy={busy}>
          Hesap oluştur
        </Button>
        <p className="text-center text-sm text-slate-600">
          Hesabınız var mı?{' '}
          <Link
            href={`/login?next=${encodeURIComponent(next)}`}
            className="font-semibold text-brand-700"
          >
            Giriş yapın
          </Link>
        </p>
      </form>
    </Card>
  );
}

export default function RegisterPage() {
  return (
    <Page title="Hesap oluştur">
      <Suspense fallback={<Loading />}>
        <RegisterForm />
      </Suspense>
    </Page>
  );
}
