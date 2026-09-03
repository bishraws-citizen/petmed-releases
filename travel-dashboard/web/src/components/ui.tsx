import {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/* ---------------- Badges ---------------- */

export type Tone = 'neutral' | 'info' | 'good' | 'warning' | 'serious' | 'critical';

/**
 * Status colour never carries meaning on its own: every badge pairs its tone
 * with a glyph and a written label.
 */
function ToneIcon({ tone }: { tone: Tone }) {
  const common = { width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': true } as const;
  if (tone === 'good') {
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8.5 6.5 12 13 4.5" />
      </svg>
    );
  }
  if (tone === 'critical' || tone === 'serious') {
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M8 2.5 15 14H1L8 2.5Z" strokeLinejoin="round" />
        <path d="M8 6.8v3.1M8 12.1h.01" />
      </svg>
    );
  }
  if (tone === 'warning') {
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 4.8V8l2.2 1.6" strokeLinejoin="round" />
      </svg>
    );
  }
  return <span className="dot" aria-hidden />;
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`}>
      <ToneIcon tone={tone} />
      {children}
    </span>
  );
}

/* ---------------- Form fields ---------------- */

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  full?: boolean;
  children: (id: string) => ReactNode;
}

export function Field({ label, hint, error, full, children }: FieldProps) {
  const id = useId();
  return (
    <div className={`field${full ? ' full' : ''}`}>
      <label className="field-label" htmlFor={id}>{label}</label>
      {children(id)}
      {error ? <span className="field-error">{error}</span>
        : hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

/* ---------------- Modal ---------------- */

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Widens the dialog for panels that carry a table. */
  wide?: boolean;
}

export function Modal({ title, onClose, children, footer, wide }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLElement>(
      'input, select, textarea, button',
    )?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panel}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------- Toasts ---------------- */

interface Toast { id: number; message: string; tone: 'info' | 'error' }

const ToastContext = createContext<(message: string, tone?: 'info' | 'error') => void>(() => {});

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const push = useCallback((message: string, tone: 'info' | 'error' = 'info') => {
    const id = (nextId.current += 1);
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 4200);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast${toast.tone === 'error' ? ' error' : ''}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ---------------- Misc ---------------- */

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-title">{title}</span>
      {hint ? <span>{hint}</span> : null}
      {action}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`.trim()}>{children}</section>;
}

export function CardHead({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="card-head">
      <div>
        <h2 className="card-title">{title}</h2>
        {sub ? <p className="card-sub">{sub}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Segmented<T extends string>({
  options, value, onChange, label,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} />;
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 16 }}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={18} />
      ))}
    </div>
  );
}

/** Debounces a fast-changing value (search boxes) so we don't refetch per keystroke. */
export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Theme preference, persisted per browser and stamped on <html> for the CSS. */
export function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(() => {
    try {
      const stored = localStorage.getItem('voyager-theme');
      if (stored === 'light' || stored === 'dark') return stored;
    } catch {
      /* private mode or blocked storage — fall back to the system setting */
    }
    return 'system';
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      if (theme === 'system') localStorage.removeItem('voyager-theme');
      else localStorage.setItem('voyager-theme', theme);
    } catch {
      /* nothing to persist to — the in-memory choice still applies */
    }
  }, [theme]);

  const cycle = useCallback(() => {
    setTheme((current) => (current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system'));
  }, []);

  return useMemo(() => ({ theme, cycle }), [theme, cycle]);
}
