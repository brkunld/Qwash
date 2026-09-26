import type { ReactNode } from 'react';
import { LEGAL_IS_DRAFT, LEGAL_UPDATED } from '@/lib/company';
import { Alert, Page } from './ui';

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Page title={title} back="/">
      {LEGAL_IS_DRAFT && (
        <Alert tone="warning">
          Bu metin taslaktır: işletme bilgileri henüz girilmedi ve yayına almadan önce bir hukukçu
          tarafından gözden geçirilmelidir.
        </Alert>
      )}
      <p className="text-xs text-slate-500">Son güncelleme: {LEGAL_UPDATED}</p>
      <article className="flex flex-col gap-3 text-sm leading-relaxed text-slate-700">
        {children}
      </article>
    </Page>
  );
}

export function H({ children }: { children: ReactNode }) {
  return <h2 className="mt-3 text-base font-semibold text-slate-900">{children}</h2>;
}

export function Ul({ children }: { children: ReactNode }) {
  return <ul className="ml-5 flex list-disc flex-col gap-1">{children}</ul>;
}
