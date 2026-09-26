'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { isAdminRole, logout, useRequireAuth } from '@/lib/auth';
import { Button, Loading } from './ui';

const NAV: { href: string; label: string; superOnly?: boolean }[] = [
  { href: '/', label: 'Peronlar' },
  { href: '/cash', label: 'Kasa' },
  { href: '/users', label: 'Kullanıcılar' },
  { href: '/refunds', label: 'İade talepleri' },
  { href: '/review', label: 'İnceleme' },
  { href: '/programs', label: 'Programlar', superOnly: true },
  { href: '/settings', label: 'Ayarlar', superOnly: true },
  { href: '/audit', label: 'Denetim kaydı' },
];

/**
 * Giris ve rol kapisi. Rol kontrolu yalniz arayuz icindir; asil yetki her istekte
 * sunucuda (AdminGuard) veritabanindan denetlenir.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const auth = useRequireAuth();
  const pathname = usePathname();

  if (auth.status !== 'authenticated') return <Loading />;

  if (!isAdminRole(auth.user.role)) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-xl font-bold">Yetkiniz yok</h1>
        <p className="text-slate-600">
          <strong>{auth.user.email}</strong> hesabı yönetici değil. Yönetici rolü komut satırından
          verilir (<code>pnpm admin:grant</code>).
        </p>
        <Button onClick={() => void logout()}>Çıkış yap</Button>
      </main>
    );
  }

  const isSuper = auth.user.role === 'SUPER_ADMIN';
  return (
    <div className="flex min-h-dvh">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white p-4">
        <Image src="/logo.png" alt="QWash" width={96} height={27} priority className="mb-1" />
        <p className="mb-5 text-xs font-semibold uppercase tracking-wide text-slate-500">Admin</p>
        <nav className="flex flex-col gap-1">
          {NAV.filter((n) => !n.superOnly || isSuper).map((n) => {
            const active = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? 'page' : undefined}
                className={`rounded-lg px-3 py-2 text-sm font-medium ${
                  active ? 'bg-brand-50 text-brand-900' : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto border-t border-slate-200 pt-4 text-xs text-slate-600">
          <p className="truncate font-medium" title={auth.user.email}>
            {auth.user.email}
          </p>
          <p className="mb-2">{isSuper ? 'Süper yönetici' : 'Yönetici'}</p>
          <Button small variant="secondary" onClick={() => void logout()}>
            Çıkış yap
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6 lg:p-8">{children}</main>
    </div>
  );
}

/** SUPER_ADMIN gerektiren sayfalarda yetkisiz gorunum. */
export function useIsSuper(): boolean {
  const auth = useRequireAuth();
  return auth.status === 'authenticated' && auth.user.role === 'SUPER_ADMIN';
}
