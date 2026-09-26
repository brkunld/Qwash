'use client';

import type { DeleteAccountResponse, DeletionPreview, Me, RefundMethod } from '@qwash/contracts';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, LinkButton, Loading, Page } from '@/components/ui';
import { api, clearAuth } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { tl } from '@/lib/format';

const METHOD: Record<RefundMethod, string> = {
  CARD: 'Ödeme yaptığınız karta',
  IBAN: 'Kendi adınıza kayıtlı IBAN hesabına',
  CASH_AT_STATION: 'İstasyonda kasadan nakit',
};

type Choice = 'FORFEIT' | 'REFUND';

function DeleteAccount({ me }: { me: Me }) {
  const router = useRouter();
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [confirmForfeit, setConfirmForfeit] = useState(false);
  const [iban, setIban] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<DeleteAccountResponse | null>(null);

  useEffect(() => {
    api<DeletionPreview>('/me/deletion-preview').then(setPreview).catch(setError);
  }, []);

  if (done) {
    return (
      <>
        <Alert tone="success">
          Hesabınız silindi.
          {done.refundRequestId &&
            ' İade talebiniz alındı; onaylandığında seçtiğiniz yöntemle ödenecek.'}
        </Alert>
        <Button
          onClick={() => {
            // Oturum burada kapanir: onceden kapansa useRequireAuth bu mesaji gostermeden
            // giris sayfasina atardi. Sunucu refresh cookie'sini zaten sildi.
            clearAuth();
            router.replace('/');
          }}
        >
          Ana sayfa
        </Button>
      </>
    );
  }
  if (!preview) return error !== null ? <Alert>{errorMessage(error)}</Alert> : <Loading />;

  const hasBalance = preview.availableKurus > 0;
  const needsIban = choice === 'REFUND' && preview.ibanRequired;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<DeleteAccountResponse>('/me/delete', {
        method: 'POST',
        body: {
          ...(hasBalance ? { balanceChoice: choice } : {}),
          ...(choice === 'FORFEIT' ? { confirmForfeit: true } : {}),
          ...(choice === 'REFUND' && iban.trim() ? { iban } : {}),
          ...(me.hasPassword ? { password } : {}),
        },
      });
      setDone(res);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  if (preview.blockers.length > 0) {
    return (
      <Alert tone="warning">
        {preview.blockers.includes('ACTIVE_HOLD')
          ? 'Süren bir yıkamanız var. Yıkama bitince hesabınızı silebilirsiniz.'
          : 'Sonuçlanmamış bir bakiye yüklemeniz var. Birkaç dakika sonra tekrar deneyin.'}
      </Alert>
    );
  }

  const canSubmit =
    (!hasBalance || (choice === 'FORFEIT' && confirmForfeit) || choice === 'REFUND') &&
    (!needsIban || iban.trim().length > 0) &&
    (!me.hasPassword || password.length > 0);

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Alert tone="warning">
        Hesabınız silinince kişisel bilgileriniz anonimleştirilir ve bu işlem geri alınamaz. Yasal
        saklama süresi olan mali kayıtlar kimliğiniz olmadan tutulur.
      </Alert>

      {hasBalance && (
        <Card>
          <p className="text-sm text-slate-500">Kalan bakiyeniz</p>
          <p className="text-3xl font-extrabold">{tl(preview.availableKurus)}</p>
          <p className="mt-2 text-sm text-slate-600">
            Bakiyenizi kullanmak isterseniz silmekten vazgeçebilirsiniz. Silmek istiyorsanız birini
            seçin:
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {(['REFUND', 'FORFEIT'] as const).map((c) => (
              <label
                key={c}
                className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border p-3 ${
                  choice === c ? 'border-sky-600 bg-sky-50' : 'border-slate-300'
                }`}
              >
                <input
                  type="radio"
                  name="choice"
                  checked={choice === c}
                  onChange={() => setChoice(c)}
                  className="size-5"
                />
                <span>{c === 'REFUND' ? 'İade talep et' : 'Bakiyemden vazgeçiyorum'}</span>
              </label>
            ))}
          </div>

          {choice === 'REFUND' && (
            <div className="mt-4 flex flex-col gap-3">
              <ul className="flex flex-col gap-1 text-sm">
                {preview.allocation.map((p, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span className="text-slate-600">{METHOD[p.method]}</span>
                    <span className="font-semibold">{tl(p.amountKurus)}</span>
                  </li>
                ))}
              </ul>
              {(preview.ibanRequired || preview.hasCashPart) && (
                <Field
                  label={preview.ibanRequired ? 'IBAN' : 'IBAN (isteğe bağlı)'}
                  inputMode="text"
                  autoComplete="off"
                  placeholder="TR00 0000 0000 0000 0000 0000 00"
                  required={preview.ibanRequired}
                  value={iban}
                  onChange={(e) => setIban(e.target.value)}
                  hint={`Hesap ${preview.holderName ?? 'sizin'} adına olmalı. ${
                    preview.hasCashPart && !preview.ibanRequired
                      ? 'Girerseniz nakit kısım da bu hesaba gönderilir.'
                      : ''
                  }`}
                />
              )}
              <p className="text-xs text-slate-500">
                İade talebi yönetici onayıyla işlenir; bu sürede tutar bloke kalır.
              </p>
            </div>
          )}

          {choice === 'FORFEIT' && (
            <label className="mt-4 flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={confirmForfeit}
                onChange={(e) => setConfirmForfeit(e.target.checked)}
                className="mt-0.5 size-5"
              />
              <span>
                {tl(preview.availableKurus)} bakiyemden vazgeçtiğimi ve bunun geri alınamayacağını
                kabul ediyorum.
              </span>
            </label>
          )}
        </Card>
      )}

      {me.hasPassword && (
        <Field
          label="Şifreniz"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      )}

      {error !== null && <Alert>{errorMessage(error)}</Alert>}
      <Button type="submit" variant="danger" busy={busy} disabled={!canSubmit}>
        Hesabımı kalıcı olarak sil
      </Button>
      <LinkButton href="/account" variant="secondary">
        Vazgeç
      </LinkButton>
    </form>
  );
}

export default function DeleteAccountPage() {
  const auth = useRequireAuth();
  return (
    <Page title="Hesabı sil" back="/account">
      {auth.status === 'authenticated' ? <DeleteAccount me={auth.user} /> : <Loading />}
    </Page>
  );
}
