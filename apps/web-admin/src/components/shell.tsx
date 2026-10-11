'use client';

import {
  ArrowUUpLeftIcon,
  CashRegisterIcon,
  ClipboardTextIcon,
  ClockCounterClockwiseIcon,
  CreditCardIcon,
  GarageIcon,
  GearSixIcon,
  ListIcon,
  SignOutIcon,
  SlidersHorizontalIcon,
  UsersIcon,
  XIcon,
  type Icon,
} from '@phosphor-icons/react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { isAdminRole, logout, useRequireAuth } from '@/lib/auth';
import { Button, Loading } from './ui';

const NAV: { href: string; label: string; icon: Icon; superOnly?: boolean }[] = [
  { href: '/', label: 'Peronlar', icon: GarageIcon },
  { href: '/cash', label: 'Kasa', icon: CashRegisterIcon },
  { href: '/users', label: 'Kullanıcılar', icon: UsersIcon },
  { href: '/refunds', label: 'İade talepleri', icon: ArrowUUpLeftIcon },
  { href: '/review', label: 'İnceleme', icon: ClipboardTextIcon },
  { href: '/card-review', label: 'Ödeme incelemesi', icon: CreditCardIcon },
  { href: '/programs', label: 'Programlar', icon: SlidersHorizontalIcon, superOnly: true },
  { href: '/settings', label: 'Ayarlar', icon: GearSixIcon, superOnly: true },
  { href: '/audit', label: 'Denetim kaydı', icon: ClockCounterClockwiseIcon },
];

/*
 * Duzen (Burak, 2026-10-12: Windows'ta tam ekran, tablette tablet, telefonda telefon boyutu):
 * - lg (>=1024): tam kenar menu (ikon + etiket), sabit.
 * - md (768-1023): yalniz ikonlu ince serit; etiket ipucu olarak.
 * - telefon (<768): ustte cubuk + soldan acilan menu (dialog; Esc ve disari tiklama kapatir).
 */

/**
 * Giris ve rol kapisi. Rol kontrolu yalniz arayuz icindir; asil yetki her istekte
 * sunucuda (AdminGuard) veritabanindan denetlenir.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const auth = useRequireAuth();
  const pathname = usePathname();
  const drawer = useRef<HTMLDialogElement>(null);

  // Sayfa degisince telefon menusu kapanir.
  useEffect(() => {
    drawer.current?.close();
  }, [pathname]);

  if (auth.status !== 'authenticated') {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Loading />
      </div>
    );
  }

  if (!isAdminRole(auth.user.role)) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-xl font-semibold">Yetkiniz yok</h1>
        <p className="text-ink-muted">
          <strong className="text-ink">{auth.user.email}</strong> hesabı yönetici değil. Yönetici
          rolü komut satırından verilir (<code>pnpm admin:grant</code>).
        </p>
        <Button onClick={() => void logout()}>Çıkış yap</Button>
      </main>
    );
  }

  const isSuper = auth.user.role === 'SUPER_ADMIN';
  const items = NAV.filter((n) => !n.superOnly || isSuper);
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const account = { email: auth.user.email, role: isSuper ? 'Süper yönetici' : 'Yönetici' };

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[72px_minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)]">
      {/* Telefon: ust cubuk */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-surface/90 px-4 backdrop-blur md:hidden">
        <Link href="/" aria-label="Peronlar" className="flex items-center gap-2">
          <Image src="/logo.png" alt="QWash" width={84} height={24} priority />
          <span className="text-xs font-medium text-ink-muted">Admin</span>
        </Link>
        <button
          type="button"
          onClick={() => drawer.current?.showModal()}
          aria-label="Menüyü aç"
          className="-mr-2 flex size-11 items-center justify-center rounded-[10px] text-ink-soft hover:bg-surface-muted"
        >
          <ListIcon className="size-6" />
        </button>
      </header>

      {/* Telefon: soldan acilan menu */}
      <dialog
        ref={drawer}
        aria-label="Menü"
        onClick={(e) => {
          if (e.target === drawer.current) drawer.current?.close();
        }}
        className="m-0 h-dvh max-h-dvh w-[min(84vw,300px)] max-w-none bg-surface p-0 text-ink backdrop:bg-black/40 open:flex md:hidden"
      >
        <div className="flex w-full flex-col p-3">
          <div className="mb-3 flex items-center justify-between px-2 pt-1">
            <Image src="/logo.png" alt="QWash" width={84} height={24} />
            <button
              type="button"
              onClick={() => drawer.current?.close()}
              aria-label="Menüyü kapat"
              className="flex size-11 items-center justify-center rounded-[10px] text-ink-soft hover:bg-surface-muted"
            >
              <XIcon className="size-5" />
            </button>
          </div>
          <NavList items={items} isActive={isActive} expanded />
          <AccountBox {...account} expanded />
        </div>
      </dialog>

      {/* Tablet ve masaustu: kenar menu */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line bg-surface md:flex">
        <div className="flex h-16 items-center justify-center px-3 lg:justify-start lg:px-5">
          <Link href="/" aria-label="Peronlar" className="flex items-center gap-2">
            <Image
              src="/logo.png"
              alt="QWash"
              width={92}
              height={26}
              priority
              className="hidden lg:block"
            />
            <Image src="/icon-mark.png" alt="QWash" width={36} height={36} className="lg:hidden" />
            <span className="hidden text-xs font-medium text-ink-muted lg:inline">Admin</span>
          </Link>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
          <NavList items={items} isActive={isActive} />
          <AccountBox {...account} />
        </div>
      </aside>

      <main className="min-w-0 px-4 py-5 sm:px-6 md:py-7 lg:px-10 lg:py-8">
        <div className="mx-auto w-full max-w-[1400px]">{children}</div>
      </main>
    </div>
  );
}

function NavList({
  items,
  isActive,
  expanded = false,
}: {
  items: typeof NAV;
  isActive: (href: string) => boolean;
  /** true: her zaman etiketli (telefon menusu); false: md'de yalniz ikon, lg'de etiketli. */
  expanded?: boolean;
}) {
  return (
    <nav aria-label="Ana menü" className="flex flex-col gap-0.5">
      {items.map(({ href, label, icon: NavIcon }) => {
        const active = isActive(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            title={expanded ? undefined : label}
            className={`group flex min-h-11 items-center gap-3 rounded-[10px] px-3 text-sm font-medium transition-colors ${
              expanded ? '' : 'justify-center lg:justify-start'
            } ${
              active
                ? 'bg-brand-50 text-brand-900'
                : 'text-ink-soft hover:bg-surface-muted hover:text-ink'
            }`}
          >
            <NavIcon
              aria-hidden
              weight={active ? 'fill' : 'regular'}
              className={`size-5 shrink-0 ${active ? 'text-brand-600' : 'text-ink-muted group-hover:text-ink-soft'}`}
            />
            <span className={expanded ? '' : 'sr-only lg:not-sr-only'}>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function AccountBox({
  email,
  role,
  expanded = false,
}: {
  email: string;
  role: string;
  expanded?: boolean;
}) {
  return (
    <div className="mt-auto border-t border-line pt-3">
      <div className={expanded ? 'px-3 pb-2' : 'hidden px-3 pb-2 lg:block'}>
        <p className="truncate text-sm font-medium text-ink" title={email}>
          {email}
        </p>
        <p className="text-xs text-ink-muted">{role}</p>
      </div>
      <button
        type="button"
        onClick={() => void logout()}
        title={expanded ? undefined : 'Çıkış yap'}
        className={`flex min-h-11 w-full items-center gap-3 rounded-[10px] px-3 text-sm font-medium text-ink-soft hover:bg-surface-muted hover:text-ink ${
          expanded ? '' : 'justify-center lg:justify-start'
        }`}
      >
        <SignOutIcon aria-hidden className="size-5 shrink-0 text-ink-muted" />
        <span className={expanded ? '' : 'sr-only lg:not-sr-only'}>Çıkış yap</span>
      </button>
    </div>
  );
}

/** SUPER_ADMIN gerektiren sayfalarda yetkisiz gorunum. */
export function useIsSuper(): boolean {
  const auth = useRequireAuth();
  return auth.status === 'authenticated' && auth.user.role === 'SUPER_ADMIN';
}
