'use client';

import type { Me } from '@qwash/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, Loading, Page } from '@/components/ui';
import { api, updateUser } from '@/lib/api';
import { logout, useRequireAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';

function Account({ me }: { me: Me }) {
  const router = useRouter();
  const [fullName, setFullName] = useState(me.fullName ?? '');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [resending, setResending] = useState(false);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setNotice(null);
    try {
      updateUser(await api<Me>('/me/profile', { method: 'PATCH', body: { fullName } }));
      setNotice({ tone: 'success', text: 'Adınız kaydedildi.' });
    } catch (err) {
      setNotice({ tone: 'error', text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  async function resend() {
    setResending(true);
    setNotice(null);
    try {
      await api<void>('/auth/resend-verification', { method: 'POST' });
      setNotice({ tone: 'success', text: 'Doğrulama bağlantısı e-postanıza gönderildi.' });
    } catch (err) {
      setNotice({ tone: 'error', text: errorMessage(err) });
    } finally {
      setResending(false);
    }
  }

  async function signOut() {
    await logout();
    router.replace('/');
  }

  return (
    <>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      <Card>
        <p className="text-sm text-slate-500">E-posta</p>
        <p className="font-semibold break-all">{me.email}</p>
        {me.emailVerified ? (
          <p className="mt-1 text-sm text-emerald-700">Doğrulandı</p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            <p className="text-sm text-amber-700">
              Doğrulanmadı. Kartla bakiye yüklemek için e-postanızı doğrulayın.
            </p>
            <Button variant="secondary" onClick={resend} busy={resending}>
              Doğrulama bağlantısını tekrar gönder
            </Button>
          </div>
        )}
      </Card>

      <Card>
        {me.nameLocked ? (
          <>
            <p className="text-sm text-slate-500">Ad soyad</p>
            <p className="font-semibold">{me.fullName}</p>
            <p className="mt-1 text-xs text-slate-500">
              İlk kart yüklemesinden sonra ad değiştirilemez (iadeler bu ada yapılır). Değişiklik
              için destekle iletişime geçin.
            </p>
          </>
        ) : (
          <form onSubmit={saveName} className="flex flex-col gap-3">
            <Field
              label="Ad soyad"
              autoComplete="name"
              required
              minLength={2}
              maxLength={100}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
            <Button type="submit" variant="secondary" busy={saving}>
              Kaydet
            </Button>
          </form>
        )}
      </Card>

      <Button variant="secondary" onClick={signOut}>
        Çıkış yap
      </Button>
      <Link href="/account/delete" className="py-2 text-center text-sm text-red-700 underline">
        Hesabımı sil
      </Link>
    </>
  );
}

export default function AccountPage() {
  const auth = useRequireAuth();
  return (
    <Page title="Hesap">
      {auth.status === 'authenticated' ? <Account me={auth.user} /> : <Loading />}
    </Page>
  );
}
