import { useState } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

// Masaustu operator paneli icin kucuk ortak parcalar. Yogun tablolar, kucuk dokunma alani
// yeterli (musteri PWA'sinin aksine); yine de kontrast ve odak halkasi korunur.

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  children,
  className = '',
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
      {title && <h2 className="mb-3 text-base font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

type Variant = 'primary' | 'secondary' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-500 text-slate-900 hover:bg-brand-600 disabled:bg-brand-200',
  secondary:
    'border border-slate-300 bg-white text-slate-900 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
};

export function Button({
  variant = 'primary',
  busy = false,
  small = false,
  children,
  disabled,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  busy?: boolean;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={`rounded-lg font-semibold transition-colors disabled:cursor-not-allowed ${
        small ? 'px-3 py-1.5 text-sm' : 'px-4 py-2 text-sm'
      } ${VARIANTS[variant]} ${className}`}
    >
      {busy ? 'Bekleyin…' : children}
    </button>
  );
}

const INPUT =
  'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200';

export function Field({
  label,
  hint,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <input {...rest} className={INPUT} />
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Select({
  label,
  children,
  className = '',
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <select {...rest} className={INPUT}>
        {children}
      </select>
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
    info: 'border-slate-200 bg-slate-50 text-slate-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
  };
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-lg border p-3 text-sm ${tones[tone]}`}
    >
      {children}
    </div>
  );
}

const BADGES = {
  green: 'bg-emerald-100 text-emerald-800',
  amber: 'bg-amber-100 text-amber-900',
  red: 'bg-red-100 text-red-800',
  slate: 'bg-slate-100 text-slate-700',
  blue: 'bg-sky-100 text-sky-800',
};

export function Badge({
  tone = 'slate',
  children,
}: {
  tone?: keyof typeof BADGES;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${BADGES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Loading({ label = 'Yükleniyor…' }: { label?: string }) {
  return (
    <p className="py-10 text-center text-slate-500" role="status">
      {label}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-slate-500">{children}</p>;
}

/** Yatay kaydirilabilir tablo sarmalayici. */
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  );
}

export const TH =
  'border-b border-slate-200 px-3 py-2 text-xs font-semibold uppercase text-slate-500';
export const TD = 'border-b border-slate-100 px-3 py-2 align-top';

/** Onay gerektiren tehlikeli eylem icin satir ici iki adimli dugme (tarayici confirm() yok). */
export function ConfirmButton({
  label,
  confirmLabel = 'Emin misiniz? Evet',
  onConfirm,
  busy,
  variant = 'danger',
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void;
  busy?: boolean;
  variant?: Variant;
}) {
  return <ConfirmInner {...{ label, confirmLabel, onConfirm, busy, variant }} />;
}

function ConfirmInner({
  label,
  confirmLabel,
  onConfirm,
  busy,
  variant,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  variant: Variant;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <Button small variant="secondary" onClick={() => setArmed(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span className="inline-flex gap-1">
      <Button
        small
        variant={variant}
        busy={busy}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button small variant="secondary" onClick={() => setArmed(false)}>
        Vazgeç
      </Button>
    </span>
  );
}
