import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ComponentType, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Dialog as RadixDialog, DropdownMenu as RadixMenu, Slot } from 'radix-ui';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Check as CheckIcon, Copy, X } from 'lucide-react';

/**
 * Shared UI primitives (spec §110): accessible, consistent, themeable via CSS tokens.
 * Styling is Tailwind (styles.css); behaviour for overlays comes from Radix.
 */

/** Joins class names; later Tailwind utilities win over earlier ones. */
export const cn = (...c: ClassValue[]) => twMerge(clsx(c));

/* Theme: dark unless the person chose light on this device. */
export type Theme = 'dark' | 'light';
const THEME_KEY = 'ao.theme';
export function getTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode: the choice lasts for this page */
  }
}
if (typeof document !== 'undefined') document.documentElement.dataset.theme = getTheme();
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>(getTheme);
  return [
    theme,
    (t) => {
      setTheme(t);
      set(t);
    },
  ];
}

type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'icon' | 'icon-sm';

/** Classes of a button, for elements that are not a <button> (a router link, an anchor). */
export const buttonClass = (variant: ButtonVariant = 'default', size?: ButtonSize, className?: string) =>
  cn('btn', variant !== 'default' && `btn-${variant}`, (size === 'sm' || size === 'icon-sm') && 'btn-sm', (size === 'icon' || size === 'icon-sm') && 'btn-icon', className);

export function Button({ variant = 'default', size, loading, asChild, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; loading?: boolean; /** Render the child element (a link) with the button's look. */ asChild?: boolean }) {
  if (asChild) return <Slot.Root className={buttonClass(variant, size, className)} {...(rest as HTMLAttributes<HTMLElement>)}>{children}</Slot.Root>;
  return (
    <button className={buttonClass(variant, size, className)} aria-busy={loading || undefined} {...rest} disabled={rest.disabled || loading}>
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Card({ title, description, actions, children, className, padded = true }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cn('card', className)}>
      {(title || actions) && (
        <header className="card-header">
          <div className="min-w-0">
            {typeof title === 'string' ? <h2>{title}</h2> : title}
            {description && <p className="muted small">{description}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {padded ? <div className="card-body">{children}</div> : children}
    </section>
  );
}

/** Stat tiles sit in a `StatStrip` (or any element with the class `grid-stats`). */
export function StatStrip({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid-stats', className)}>{children}</div>;
}

export function Stat({ label, value, attention, hint, children }: { label: string; value: ReactNode; attention?: boolean; hint?: string; /** A line under the value (a meter, a caption). */ children?: ReactNode }) {
  return (
    <div className={cn('stat', attention && 'stat-attention')} title={hint}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {children && <div className="mt-1.5 text-xs text-fg-3">{children}</div>}
    </div>
  );
}

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'neutral';
export function Badge({ tone = 'neutral', live, plain, children, className }: { tone?: Tone; live?: boolean; /** No status dot: a label, not a state. */ plain?: boolean; children: ReactNode; className?: string }) {
  return <span className={cn('badge', tone !== 'neutral' && `badge-${tone}`, live && 'badge-live', plain && 'badge-plain', className)}>{children}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-2">
      <span className="spinner" aria-hidden="true" />
      {label ? <span className="muted">{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton h-4', className)} aria-hidden="true" />;
}

export function Field({ label, hint, error, children, id, className }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode; id?: string; className?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className={cn('field', className)}>
      <label htmlFor={fid}>{label}</label>
      {children(fid)}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cn('input', p.className)} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cn('select', p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cn('textarea', p.className)} />;

/** A checkbox or radio with its label; `children` is the label, `hint` a line under it. */
export function Check({ children, hint, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { hint?: ReactNode }) {
  return (
    <label className={cn('check', className)}>
      <input type="checkbox" {...rest} />
      <span>
        {children}
        {hint && <span className="block text-xs text-fg-3">{hint}</span>}
      </span>
    </label>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: Array<{ id: T; label: ReactNode }>; value: T; onChange: (t: T) => void; label: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          className="tab"
          aria-selected={value === t.id}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            const next = (i + d + tabs.length) % tabs.length;
            onChange(tabs[next]!.id);
            refs.current[next]?.focus();
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Modal dialog: focus trap, Escape and outside click close it, focus returns to what opened it. */
export function Dialog({ open, title, onClose, children, footer, className }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; className?: string }) {
  return (
    <RadixDialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-backdrop" />
        <RadixDialog.Content className={cn('dialog', className)} aria-describedby={undefined}>
          <div className="dialog-header">
            <RadixDialog.Title asChild>
              <h2>{title}</h2>
            </RadixDialog.Title>
            <RadixDialog.Close className={buttonClass('ghost', 'icon-sm')} aria-label="Close dialog">
              <X aria-hidden="true" />
            </RadixDialog.Close>
          </div>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-footer">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Dropdown menu opened by `trigger` (a button). */
export function Menu({ trigger, children, align = 'end', side = 'bottom' }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'center' | 'end'; side?: 'top' | 'right' | 'bottom' | 'left' }) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content className="menu" align={align} side={side} sideOffset={6} collisionPadding={8}>
          {children}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}
export function MenuItem({ icon: I, children, onSelect, className }: { icon?: Icon; children: ReactNode; onSelect?: () => void; className?: string }) {
  return (
    <RadixMenu.Item className={cn('menu-item', className)} onSelect={onSelect}>
      {I && <I aria-hidden="true" />}
      {children}
    </RadixMenu.Item>
  );
}
export const MenuLabel = ({ children }: { children: ReactNode }) => <RadixMenu.Label className="menu-label">{children}</RadixMenu.Label>;
export const MenuSeparator = () => <RadixMenu.Separator className="menu-sep" />;

export function EmptyState({ title, children, action, icon: I }: { title: string; children?: ReactNode; action?: ReactNode; icon?: Icon }) {
  return (
    <div className="empty">
      {I && (
        <span className="empty-icon">
          <I aria-hidden="true" />
        </span>
      )}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Alert({ tone = 'info', children, className }: { tone?: 'info' | 'warn' | 'danger'; children: ReactNode; className?: string }) {
  return (
    <div className={cn(`alert alert-${tone}`, className)} role={tone === 'danger' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function KeyValue({ items, className }: { items: Array<[ReactNode, ReactNode]>; className?: string }) {
  return (
    <dl className={cn('kv', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt>{k}</dt>
          <dd>{v ?? <span className="muted">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Progress({ value, label }: { value: number | null; label: string }) {
  if (value === null) return null;
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${v}%` }} />
    </div>
  );
}

/** Capacity of a worker: one cell per task it can run at once, filled for the ones running. */
export function SlotMeter({ used, max, offline }: { used: number; max: number; offline?: boolean }) {
  const cells = Math.min(Math.max(max, used, 1), 16);
  return (
    <span className={cn('slots', offline && 'off')} role="img" aria-label={`${used} of ${max} task slots in use`}>
      {Array.from({ length: cells }, (_, i) => (
        <i key={i} className={i < used ? 'on' : undefined} />
      ))}
    </span>
  );
}

/** Copies `value`; shows a check for a moment. */
export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button type="button" className={buttonClass('ghost', 'icon-sm', className)} aria-label={label} title={label} onClick={() => void navigator.clipboard?.writeText(value).then(() => setDone(true))}>
      {done ? <CheckIcon aria-hidden="true" className="text-ok" /> : <Copy aria-hidden="true" />}
    </button>
  );
}

/** Relative time, e.g. "3m ago". */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return `in ${formatDuration(-s * 1000)}`;
  if (s < 10) return 'just now';
  return `${formatDuration(s * 1000)} ago`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
