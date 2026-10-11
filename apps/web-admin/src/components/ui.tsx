import {
  CheckCircleIcon,
  CircleNotchIcon,
  InfoIcon,
  TrayIcon,
  WarningCircleIcon,
  WarningOctagonIcon,
} from '@phosphor-icons/react/dist/ssr';
import { useState } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

// Operator paneli ortak parcalari. Kose sistemi: kontroller 10px, kartlar 16px, rozet tam yuvarlak.
// Masaustunde yogun, dokunmatik ekranda (tablet/telefon) en az 40px dokunma alani.

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
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[1.75rem]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 max-w-[70ch] text-sm leading-relaxed text-ink-muted">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-line bg-surface p-4 shadow-[0_1px_2px_rgb(21_24_29/0.04)] sm:p-5 ${className}`}
    >
      {(title || actions) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-[15px] font-semibold text-ink">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-brand-500 text-[#15181d] hover:bg-brand-600 disabled:bg-brand-200 disabled:text-ink-muted',
  secondary:
    'border border-line-strong bg-surface text-ink hover:bg-surface-muted disabled:text-ink-faint',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300 dark:disabled:bg-red-950',
  ghost: 'text-ink-soft hover:bg-surface-muted hover:text-ink disabled:text-ink-faint',
};

export function Button({
  variant = 'primary',
  busy = false,
  small = false,
  icon,
  children,
  disabled,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  busy?: boolean;
  small?: boolean;
  /** Etiketin solundaki ikon (Phosphor). */
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] font-medium transition-[background-color,transform] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100 ${
        small ? 'min-h-10 px-3 text-sm sm:min-h-8' : 'min-h-11 px-4 text-sm sm:min-h-10'
      } ${VARIANTS[variant]} ${className}`}
    >
      {busy ? (
        <CircleNotchIcon aria-hidden className="size-4 animate-spin" />
      ) : (
        icon && <span className="-ml-0.5 flex size-4 items-center justify-center">{icon}</span>
      )}
      {busy ? 'Bekleyin…' : children}
    </button>
  );
}

const INPUT =
  'min-h-11 w-full rounded-[10px] border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-faint outline-none transition-colors focus:border-brand-500 focus:ring-3 focus:ring-brand-500/20 disabled:bg-surface-muted disabled:text-ink-muted sm:min-h-10';

export function Field({
  label,
  hint,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-sm font-medium text-ink-soft">{label}</span>
      <input {...rest} className={INPUT} />
      {hint && <span className="text-xs leading-relaxed text-ink-muted">{hint}</span>}
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
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-sm font-medium text-ink-soft">{label}</span>
      <select {...rest} className={INPUT}>
        {children}
      </select>
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
  const { box, Icon } = ALERTS[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex gap-2.5 rounded-xl border px-3.5 py-3 text-sm leading-relaxed ${box}`}
    >
      <Icon aria-hidden weight="fill" className="mt-0.5 size-4 shrink-0 opacity-80" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const BADGES = {
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
  amber: 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200',
  red: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
  slate: 'bg-surface-muted text-ink-soft',
  blue: 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300',
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
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGES[tone]}`}
    >
      {children}
    </span>
  );
}

/** Yuklenirken icerik iskeleti (son duzenin kabaca sekli). */
export function Loading({ label = 'Yükleniyor…' }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3 py-6">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-14 animate-pulse rounded-xl bg-surface-muted"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function Empty({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-surface-muted text-ink-muted">
        {icon ?? <TrayIcon aria-hidden className="size-5" />}
      </span>
      <p className="max-w-[44ch] text-sm text-ink-muted">{children}</p>
    </div>
  );
}

/** Yatay kaydirilabilir tablo sarmalayici; telefonda kart kenarina tasar. */
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto sm:-mx-5">
      <table className="w-full min-w-[560px] text-left text-sm">{children}</table>
    </div>
  );
}

export const TH =
  'whitespace-nowrap border-b border-line bg-surface-sunken px-4 py-2.5 text-xs font-medium text-ink-muted first:pl-4 sm:first:pl-5 last:pr-4 sm:last:pr-5';
export const TD =
  'border-b border-line px-4 py-3 align-top first:pl-4 sm:first:pl-5 last:pr-4 sm:last:pr-5';

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
    <span className="inline-flex flex-wrap gap-1.5">
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
