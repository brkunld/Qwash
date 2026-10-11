'use client';

import {
  ArrowLeftIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  DropIcon,
  InfoIcon,
  QrCodeIcon,
  UserCircleIcon,
  WalletIcon,
  WarningCircleIcon,
  WarningOctagonIcon,
  type Icon,
} from '@phosphor-icons/react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

// Musteri PWA'si ortak parcalari. Tek elle, peronda, islak parmakla kullanim: buyuk dokunma
// alanlari (en az 48 px), yuksek kontrast. Kose sistemi: kontroller 12px, kartlar 20px.
//
// Duzen (Burak, 2026-10-12: telefon, tablet ve masaustu kendi boyutunda):
// - telefon (<768): ust logo cubugu + altta sabit sekme cubugu (Yikama, Bakiye, Hesap).
// - tablet (768-1023): ustte tam genislik menu, icerik ortada.
// - masaustu (>=1024): iki sutun; solda sayfa basligi ve yardim, sagda islem.

const TABS: { href: string; label: string; icon: Icon }[] = [
  { href: '/', label: 'Yıkama', icon: DropIcon },
  { href: '/wallet', label: 'Bakiye', icon: WalletIcon },
  { href: '/account', label: 'Hesap', icon: UserCircleIcon },
];

function useTabActive() {
  const pathname = usePathname();
  return (href: string) =>
    href === '/'
      ? pathname === '/' || pathname.startsWith('/b/') || pathname.startsWith('/session/')
      : pathname.startsWith(href);
}

export function Page({
  title,
  back,
  children,
}: {
  title?: string;
  back?: string;
  children: ReactNode;
}) {
  const isActive = useTabActive();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 md:h-16 md:px-6">
          <Link href="/" aria-label="QWash ana sayfa" className="-ml-1 rounded-lg p-1">
            <Image src="/logo.png" alt="QWash" width={96} height={27} priority />
          </Link>
          <nav aria-label="Ana menü" className="hidden items-center gap-1 md:flex">
            {TABS.map(({ href, label, icon: TabIcon }) => {
              const active = isActive(href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex min-h-11 items-center gap-2 rounded-xl px-3.5 text-sm font-medium transition-colors ${
                    active
                      ? 'bg-brand-50 text-brand-900'
                      : 'text-ink-soft hover:bg-surface-muted hover:text-ink'
                  }`}
                >
                  <TabIcon
                    aria-hidden
                    weight={active ? 'fill' : 'regular'}
                    className={`size-5 ${active ? 'text-brand-600' : 'text-ink-muted'}`}
                  />
                  {label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-6xl flex-1 content-start gap-6 px-4 pb-10 pt-5 md:max-w-xl md:gap-8 md:px-6 md:pt-8 lg:max-w-6xl lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-16 lg:pt-14">
        {/* Masaustu: sol sutun (baslik ve yardim); telefonda ve tablette yalniz baslik. */}
        <aside className="flex flex-col gap-3 lg:sticky lg:top-28 lg:self-start">
          {back && (
            <Link
              href={back}
              className="-ml-2 inline-flex min-h-11 items-center gap-1.5 self-start rounded-xl px-2 text-sm font-medium text-ink-soft hover:bg-surface-muted"
            >
              <ArrowLeftIcon aria-hidden className="size-4" />
              Geri
            </Link>
          )}
          {title ? (
            <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight lg:text-5xl">
              {title}
            </h1>
          ) : (
            <BrandIntro />
          )}
          <HowItWorks />
        </aside>

        <div className="flex min-w-0 flex-col gap-4 lg:max-w-lg">{children}</div>
      </main>

      <footer className="mx-auto flex w-full max-w-6xl justify-center gap-5 px-4 pb-24 text-xs text-ink-muted md:justify-start md:px-6 md:pb-8">
        <Link href="/legal/terms" className="underline-offset-2 hover:underline">
          Kullanım Şartları
        </Link>
        <Link href="/legal/kvkk" className="underline-offset-2 hover:underline">
          KVKK Aydınlatma Metni
        </Link>
      </footer>

      {/* Telefon: alt sekme cubugu (bas parmak erisimi). */}
      <nav
        aria-label="Ana menü"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        <div className="grid grid-cols-3">
          {TABS.map(({ href, label, icon: TabIcon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-16 flex-col items-center justify-center gap-1 text-xs font-medium ${
                  active ? 'text-brand-700' : 'text-ink-muted'
                }`}
              >
                <TabIcon
                  aria-hidden
                  weight={active ? 'fill' : 'regular'}
                  className={`size-6 ${active ? 'text-brand-600' : ''}`}
                />
                {label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

/** Basliksiz sayfalarda (ana sayfa, peron, yikama) masaustunde sol sutunun basligi. */
function BrandIntro() {
  return (
    <div className="hidden lg:block">
      <h1 className="text-5xl font-semibold leading-[1.05] tracking-tight">
        Kendin yıka,
        <br />
        <span className="text-brand-600">saniyesi kadar öde.</span>
      </h1>
      <p className="mt-4 max-w-[42ch] text-base leading-relaxed text-ink-muted">
        Peronu telefonunla başlat, istediğin an durdur. Kullanmadığın süre bakiyende kalır.
      </p>
    </div>
  );
}

/** Masaustunde sol sutunda kisa yardim; telefonda yer kaplamaz. */
function HowItWorks() {
  const steps = [
    { icon: QrCodeIcon, text: 'Peron ekranındaki QR kodu okut.' },
    { icon: DropIcon, text: 'Programı ve süreyi seç, yıkamayı başlat.' },
    { icon: WalletIcon, text: 'Erken bitirirsen kalan tutar bakiyene döner.' },
  ];
  return (
    <ol className="mt-6 hidden flex-col gap-3 lg:flex">
      {steps.map(({ icon: StepIcon, text }) => (
        <li key={text} className="flex items-center gap-3 text-sm text-ink-soft">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-muted text-ink-muted">
            <StepIcon aria-hidden className="size-5" />
          </span>
          {text}
        </li>
      ))}
    </ol>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-[20px] border border-line bg-surface p-5 shadow-[0_1px_2px_rgb(21_24_29/0.04)] ${className}`}
    >
      {children}
    </section>
  );
}

type Variant = 'primary' | 'secondary' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-brand-500 text-[#15181d] hover:bg-brand-600 disabled:bg-brand-200 disabled:text-ink-muted',
  secondary:
    'border border-line-strong bg-surface text-ink hover:bg-surface-muted disabled:text-ink-faint',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300 dark:disabled:bg-red-950',
};

const BUTTON =
  'inline-flex min-h-13 w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-base font-semibold transition-[background-color,transform] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100';

export function Button({
  variant = 'primary',
  busy = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`${BUTTON} ${VARIANTS[variant]} ${className}`}
    >
      {busy && <CircleNotchIcon aria-hidden className="size-5 animate-spin" />}
      {busy ? 'Lütfen bekleyin…' : children}
    </button>
  );
}

export function LinkButton({
  href,
  variant = 'primary',
  children,
}: {
  href: string;
  variant?: Variant;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={`${BUTTON} ${VARIANTS[variant]}`}>
      {children}
    </Link>
  );
}

export function Field({
  label,
  hint,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink-soft">{label}</span>
      <input
        {...rest}
        className="min-h-13 rounded-xl border border-line-strong bg-surface px-3.5 text-base text-ink placeholder:text-ink-faint outline-none transition-colors focus:border-brand-500 focus:ring-3 focus:ring-brand-500/20"
      />
      {hint && <span className="text-xs leading-relaxed text-ink-muted">{hint}</span>}
    </label>
  );
}

const ALERTS = {
  error: {
    box: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200',
    Icon: WarningOctagonIcon,
  },
  info: { box: 'border-line bg-surface-sunken text-ink-soft', Icon: InfoIcon },
  success: {
    box: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200',
    Icon: CheckCircleIcon,
  },
  warning: {
    box: 'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100',
    Icon: WarningCircleIcon,
  },
};

export function Alert({
  tone = 'error',
  children,
}: {
  tone?: keyof typeof ALERTS;
  children: ReactNode;
}) {
  const { box, Icon: AlertIcon } = ALERTS[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex gap-2.5 rounded-xl border px-3.5 py-3 text-sm leading-relaxed ${box}`}
    >
      <AlertIcon aria-hidden weight="fill" className="mt-0.5 size-4 shrink-0 opacity-80" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Yuklenirken icerik iskeleti. */
export function Loading({ label = 'Yükleniyor…' }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3 py-2">
      <div className="h-32 animate-pulse rounded-[20px] bg-surface-muted" />
      <div className="h-13 animate-pulse rounded-xl bg-surface-muted [animation-delay:120ms]" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
