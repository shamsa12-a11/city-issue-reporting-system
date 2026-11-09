/** Codka Magaalada logo, the language switch and the language-aware hook. */
import { Link } from 'react-router-dom';
import { Languages } from 'lucide-react';
import { LANGUAGES, useLanguage } from '../i18n/LanguageContext';
import { useAuth } from '../auth/AuthContext';

export function LogoMark({ className = 'h-9 w-9' }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#2563EB" />
      <path d="M32 13c-8.3 0-15 6.5-15 14.6C17 38.5 32 51 32 51s15-12.5 15-23.4C47 19.5 40.3 13 32 13z" fill="#FFFFFF" />
      <circle cx="32" cy="27.5" r="5.5" fill="#142D4E" />
    </svg>
  );
}

export function Logo({ light = false, to = '/' }) {
  const { t } = useLanguage();
  return (
    <Link to={to} className="flex items-center gap-2.5" aria-label={t('app.name')}>
      <LogoMark />
      <span className="leading-tight">
        <span className={`block text-[15px] font-bold tracking-wide ${light ? 'text-white' : 'text-navy'}`}>CODKA MAGAALADA</span>
        <span className={`block text-[11px] ${light ? 'text-slate-300' : 'text-muted'}`}>{t('app.tagline')}</span>
      </span>
    </Link>
  );
}

/**
 * SO / EN switch. When logged in, the choice is also saved as the user's
 * preferred language (used for new notifications and SMS).
 */
export function LanguageSwitch({ light = false }) {
  const { language, setLanguage, t } = useLanguage();
  const { isAuthenticated, user, updatePreferences } = useAuth();
  const choose = (code) => {
    if (code === language) return;
    setLanguage(code);
    if (isAuthenticated && user.preferredLanguage !== code) updatePreferences({ preferredLanguage: code }).catch(() => {});
  };
  return (
    <div
      role="group"
      aria-label={t('nav.language')}
      className={`inline-flex items-center gap-0.5 rounded-lg p-0.5 ${light ? 'bg-white/10' : 'border border-line bg-white'}`}
    >
      <Languages className={`mx-1.5 h-4 w-4 ${light ? 'text-slate-300' : 'text-muted'}`} aria-hidden="true" />
      {LANGUAGES.map((l) => (
        <button
          key={l.code}
          type="button"
          lang={l.code}
          onClick={() => choose(l.code)}
          aria-pressed={language === l.code}
          title={l.label}
          className={`rounded-md px-2 py-1 text-xs font-semibold transition-colors ${
            language === l.code ? (light ? 'bg-white text-navy' : 'bg-navy text-white') : light ? 'text-slate-200 hover:text-white' : 'text-muted hover:text-ink'
          }`}
        >
          {l.short}
        </button>
      ))}
    </div>
  );
}
