import Link from 'next/link';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

// Kucuk ortak arayuz parcasi. Tek elle, peronda, islak parmakla kullanim: buyuk dokunma
// alanlari (en az 48 px), yuksek kontrast, tek sutun.

export function Page({
  title,
  back,
  children,
}: {
  title?: string;
  back?: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-4 pb-10 pt-4">
      <header className="flex items-center justify-between">
        {back ? (
          <Link href={back} className="-ml-2 rounded-lg px-2 py-2 text-sky-700" aria-label="Geri">
            ← Geri
          </Link>
        ) : (
          <Link href="/" className="text-xl font-extrabold tracking-tight text-sky-700">
            QWASH
          </Link>
        )}
        <nav className="flex gap-1 text-sm">
          <Link href="/wallet" className="rounded-lg px-3 py-2 text-slate-700 hover:bg-slate-100">
            Bakiye
          </Link>
          <Link href="/account" className="rounded-lg px-3 py-2 text-slate-700 hover:bg-slate-100">
            Hesap
          </Link>
        </nav>
      </header>
      {title && <h1 className="text-2xl font-bold">{title}</h1>}
      {children}
    </main>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
      {children}
    </section>
  );
}

type Variant = 'primary' | 'secondary' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-sky-600 text-white hover:bg-sky-700 disabled:bg-sky-300',
  secondary:
    'bg-white text-slate-900 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
};

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
      className={`min-h-12 w-full rounded-xl px-4 py-3 text-base font-semibold transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
    >
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
    <Link
      href={href}
      className={`flex min-h-12 w-full items-center justify-center rounded-xl px-4 py-3 text-base font-semibold ${VARIANTS[variant]}`}
    >
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
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <input
        {...rest}
        className="min-h-12 rounded-xl border border-slate-300 bg-white px-3 text-base outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-200"
      />
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Alert({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'info' | 'success' | 'warning';
  children: ReactNode;
}) {
  const tones = {
    error: 'border-red-200 bg-red-50 text-red-800',
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
  };
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-xl border p-3 text-sm ${tones[tone]}`}
    >
      {children}
    </div>
  );
}

export function Loading({ label = 'Yükleniyor…' }: { label?: string }) {
  return (
    <p className="py-10 text-center text-slate-500" role="status">
      {label}
    </p>
  );
}
