import { Loader2 } from 'lucide-react';
import { useLanguage } from '../../i18n/LanguageContext';

export function Spinner({ className = 'h-5 w-5' }) {
  return <Loader2 className={`animate-spin text-royal ${className}`} aria-hidden="true" />;
}

/** Full-area loading state with an accessible label. */
export function PageSpinner({ label }) {
  const { t } = useLanguage();
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-muted" role="status" aria-live="polite">
      <Spinner className="h-7 w-7" />
      <span className="text-sm">{label || t('common.loading')}</span>
    </div>
  );
}
