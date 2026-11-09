import { useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useLanguage } from '../../i18n/LanguageContext';

/** Password input with a show/hide toggle. */
export default function PasswordField({ label, hint, error, ...rest }) {
  const { t } = useLanguage();
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          className={`block h-11 w-full rounded-lg border bg-white px-3.5 pr-11 text-sm focus:border-royal focus:outline-none focus:ring-2 focus:ring-royal/20 ${error ? 'border-critical' : 'border-line'}`}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          {...rest}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted hover:text-ink"
          aria-label={visible ? t('auth.hidePassword') : t('auth.showPassword')}
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
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
