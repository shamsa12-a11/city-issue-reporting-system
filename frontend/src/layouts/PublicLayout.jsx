/** Public pages: sticky navbar, page content, footer. */
import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { LayoutDashboard, Mail, MapPin, Menu, X } from 'lucide-react';
import { Logo, LanguageSwitch } from '../components/Brand';
import Button from '../components/ui/Button';
import { useAuth, homeForRole } from '../auth/AuthContext';
import { useLanguage } from '../i18n/LanguageContext';

function useNavItems() {
  const { t } = useLanguage();
  return [
    { to: '/', label: t('nav.home'), end: true },
    { to: '/explore', label: t('nav.explore') },
    { to: '/#how-it-works', label: t('nav.howItWorks'), hash: true },
    { to: '/#about', label: t('nav.about'), hash: true },
  ];
}

function NavItem({ item, onClick }) {
  const base = 'rounded-lg px-3 py-2 text-sm font-medium transition-colors';
  if (item.hash) {
    return (
      <Link to={item.to} onClick={onClick} className={`${base} text-muted hover:bg-page hover:text-ink`}>
        {item.label}
      </Link>
    );
  }
  return (
    <NavLink to={item.to} end={item.end} onClick={onClick} className={({ isActive }) => `${base} ${isActive ? 'text-royal' : 'text-muted hover:bg-page hover:text-ink'}`}>
      {item.label}
    </NavLink>
  );
}

export function PublicNavbar() {
  const { t } = useLanguage();
  const { isAuthenticated, user } = useAuth();
  const items = useNavItems();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname, location.hash]);

  const accountActions = isAuthenticated ? (
    <Button to={homeForRole(user.role)} size="sm" icon={LayoutDashboard}>
      {t('nav.dashboard')}
    </Button>
  ) : (
    <>
      <Button to="/login" variant="ghost" size="sm">
        {t('nav.login')}
      </Button>
      <Button to="/register" size="sm">
        {t('nav.register')}
      </Button>
    </>
  );

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-white/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Logo />
        <nav className="hidden items-center gap-1 lg:flex" aria-label="Main">
          {items.map((item) => (
            <NavItem key={item.to} item={item} />
          ))}
        </nav>
        <div className="hidden items-center gap-2 lg:flex">
          <LanguageSwitch />
          {accountActions}
        </div>
        <button type="button" className="rounded-lg p-2 text-ink hover:bg-page lg:hidden" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={t('nav.menu')}>
          {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </div>
      {open && (
        <div className="border-t border-line bg-white px-4 pb-4 pt-2 lg:hidden">
          <nav className="flex flex-col" aria-label="Main mobile">
            {items.map((item) => (
              <NavItem key={item.to} item={item} onClick={() => setOpen(false)} />
            ))}
          </nav>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <LanguageSwitch />
            {accountActions}
          </div>
        </div>
      )}
    </header>
  );
}

export function Footer() {
  const { t } = useLanguage();
  return (
    <footer className="bg-navy text-slate-300">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-3 lg:px-8">
        <div className="space-y-3">
          <Logo light />
          <p className="max-w-xs text-sm leading-relaxed">{t('landing.heroTitle')}</p>
        </div>
        <div>
          <p className="text-sm font-semibold text-white">{t('nav.explore')}</p>
          <ul className="mt-3 space-y-2 text-sm">
            <li>
              <Link to="/explore" className="hover:text-white">
                {t('nav.explore')}
              </Link>
            </li>
            <li>
              <Link to="/citizen/report" className="hover:text-white">
                {t('nav.report')}
              </Link>
            </li>
            <li>
              <Link to="/#how-it-works" className="hover:text-white">
                {t('nav.howItWorks')}
              </Link>
            </li>
            <li>
              <Link to="/#about" className="hover:text-white">
                {t('nav.about')}
              </Link>
            </li>
          </ul>
        </div>
        <div>
          <p className="text-sm font-semibold text-white">{t('landing.contactTitle')}</p>
          <ul className="mt-3 space-y-2 text-sm">
            <li className="flex gap-2">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              Muqdisho, Banaadir
            </li>
            <li className="flex gap-2">
              <Mail className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {t('landing.contactText')}
            </li>
          </ul>
        </div>
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-5 text-xs sm:px-6 lg:px-8">
          <p>
            © {new Date().getFullYear()} {t('app.name')} — {t('app.tagline')}
          </p>
          <p>{t('landing.footerRights')}</p>
        </div>
      </div>
    </footer>
  );
}

export default function PublicLayout() {
  const { loggedOutByUser, clearLoggedOut } = useAuth();
  // Arrived home after "Log out": later visits to protected pages ask to log in again.
  useEffect(() => {
    if (loggedOutByUser) clearLoggedOut();
  }, [loggedOutByUser, clearLoggedOut]);
  return (
    <div className="flex min-h-screen flex-col">
      <PublicNavbar />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
