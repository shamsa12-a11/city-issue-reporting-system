/**
 * Small building blocks used across pages: Card, Alert, EmptyState,
 * form fields, Pagination and Modal.
 */
import { useEffect, useId, useRef } from 'react';
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Info, TriangleAlert, X } from 'lucide-react';
import { useLanguage } from '../../i18n/LanguageContext';
import Button from './Button';

export function Card({ as: Tag = 'div', className = '', children, ...rest }) {
  return (
    <Tag className={`rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

export function SectionHeading({ title, text, action, className = '' }) {
  return (
    <div className={`flex flex-wrap items-end justify-between gap-3 ${className}`}>
      <div>
        <h2 className="text-lg font-semibold sm:text-xl">{title}</h2>
        {text && <p className="mt-1 text-sm text-muted">{text}</p>}
      </div>
      {action}
    </div>
  );
}

const ALERT_STYLES = {
  error: { box: 'border-critical/30 bg-critical-50 text-critical', Icon: AlertCircle },
  success: { box: 'border-success/30 bg-success-50 text-success', Icon: CheckCircle2 },
  warning: { box: 'border-warning/40 bg-warning-50 text-amber-800', Icon: TriangleAlert },
  info: { box: 'border-royal/20 bg-royal-50 text-royal-700', Icon: Info },
};

export function Alert({ tone = 'info', title, children, className = '' }) {
  const { box, Icon } = ALERT_STYLES[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`flex gap-3 rounded-lg border px-4 py-3 text-sm ${box} ${className}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? 'mt-0.5 text-ink/80' : ''}>{children}</div>}
      </div>
    </div>
  );
}

/** Error box with a retry button for failed loads. */
export function LoadError({ error, onRetry }) {
  const { t, errorMessage } = useLanguage();
  return (
    <Alert tone="error" title={t('common.somethingWrong')}>
      <p>{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </Alert>
  );
}

export function EmptyState({ icon: Icon, title, text, action, className = '' }) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-xl border border-dashed border-line bg-surface px-6 py-12 text-center ${className}`}>
      {Icon && (
        <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-royal-50 text-royal">
          <Icon className="h-6 w-6" aria-hidden="true" />
        </span>
      )}
      <p className="font-semibold text-ink">{title}</p>
      {text && <p className="mt-1 max-w-md text-sm text-muted">{text}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// ---- Form fields ----------------------------------------------------------------

const controlClass = (error) =>
  `block w-full rounded-lg border bg-white px-3.5 text-sm text-ink placeholder:text-slate-400 transition-colors focus:border-royal focus:outline-none focus:ring-2 focus:ring-royal/20 disabled:bg-page ${
    error ? 'border-critical' : 'border-line'
  }`;

function FieldShell({ id, label, hint, error, optional, children }) {
  const { t } = useLanguage();
  return (
    <div>
      {label && (
        <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink">
          {label}
          {optional && <span className="ml-1 font-normal text-muted">({t('common.optional')})</span>}
        </label>
      )}
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs font-medium text-critical">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="mt-1.5 text-xs text-muted">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

const describedBy = (id, error, hint) => (error ? `${id}-error` : hint ? `${id}-hint` : undefined);

export function TextField({ label, hint, error, optional, className = '', ...rest }) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} optional={optional}>
      <input id={id} className={`${controlClass(error)} h-11 ${className}`} aria-invalid={!!error} aria-describedby={describedBy(id, error, hint)} {...rest} />
    </FieldShell>
  );
}

export function TextArea({ label, hint, error, optional, className = '', ...rest }) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} optional={optional}>
      <textarea id={id} className={`${controlClass(error)} py-2.5 ${className}`} aria-invalid={!!error} aria-describedby={describedBy(id, error, hint)} {...rest} />
    </FieldShell>
  );
}

export function SelectField({ label, hint, error, optional, children, className = '', ...rest }) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} optional={optional}>
      <select id={id} className={`${controlClass(error)} h-11 pr-8 ${className}`} aria-invalid={!!error} aria-describedby={describedBy(id, error, hint)} {...rest}>
        {children}
      </select>
    </FieldShell>
  );
}

// ---- Pagination ------------------------------------------------------------------

export function Pagination({ pagination, onChange }) {
  const { t } = useLanguage();
  if (!pagination || pagination.total <= pagination.limit) return null;
  const { limit, offset, total } = pagination;
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <nav className="flex flex-wrap items-center justify-between gap-3 pt-2" aria-label="Pagination">
      <p className="text-sm text-muted">{t('common.showing', { from, to, total })}</p>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" icon={ChevronLeft} disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          {t('common.previous')}
        </Button>
        <Button variant="secondary" size="sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
          {t('common.next')}
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}

// ---- Modal --------------------------------------------------------------------------

export function Modal({ open, title, onClose, children, footer, wide = false }) {
  const { t } = useLanguage();
  const dialogRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-xl outline-none sm:rounded-2xl ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-muted hover:bg-page" aria-label={t('common.close')}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-4">{footer}</div>}
      </div>
    </div>
  );
}
