/** Two-column frame for the login and registration pages. */
import { Link } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { Logo, LanguageSwitch } from '../../components/Brand';
import { useLanguage } from '../../i18n/LanguageContext';

export default function AuthShell({ title, subtitle, children, footer }) {
  const { t } = useLanguage();
  const points = [t('landing.step1Text'), t('landing.step2Text'), t('landing.step4Text')];
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-navy p-10 lg:flex">
        <Logo light />
        <div className="max-w-md">
          <h2 className="text-3xl font-bold leading-tight text-white">{t('landing.heroTitle')}</h2>
          <ul className="mt-8 space-y-4">
            {points.map((p) => (
              <li key={p} className="flex gap-3 text-sm text-slate-300">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-slate-400">{t('landing.footerRights')}</p>
      </div>
      <div className="flex flex-col bg-page">
        <div className="flex items-center justify-between px-4 py-4 sm:px-8">
          <div className="lg:invisible">
            <Logo />
          </div>
          <LanguageSwitch />
        </div>
        <div className="flex flex-1 items-center justify-center px-4 pb-12 sm:px-8">
          <div className="w-full max-w-md">
            <h1 className="text-2xl font-bold">{title}</h1>
            <p className="mt-1 text-sm text-muted">{subtitle}</p>
            <div className="mt-8 rounded-xl border border-line bg-white p-6 shadow-sm">{children}</div>
            <div className="mt-6 text-center text-sm text-muted">{footer}</div>
            <p className="mt-4 text-center">
              <Link to="/" className="text-sm font-medium text-muted hover:text-ink">
                ← {t('nav.home')}
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
