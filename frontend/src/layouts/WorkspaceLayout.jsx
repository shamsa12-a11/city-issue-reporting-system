/**
 * Logged-in workspace shared by every role: navy sidebar on desktop, a
 * slide-in menu on phones, a top bar with the language switch, notifications
 * bell and account link. Each role passes its own menu sections.
 * The unread count is refreshed on navigation, every minute, and when a page
 * fires the "codka:notifications" event (after marking as read).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Bell, Globe2, LogOut, Menu, X } from 'lucide-react';
import { Logo, LanguageSwitch } from '../components/Brand';
import { useAuth } from '../auth/AuthContext';
import { useLanguage } from '../i18n/LanguageContext';
import { notificationApi } from '../api/services';

export const NOTIFICATIONS_CHANGED = 'codka:notifications';

function useUnreadCount() {
  const [count, setCount] = useState(0);
  const location = useLocation();
  const refresh = useCallback(() => {
    notificationApi
      .unreadCount()
      .then((r) => setCount(r.unreadCount))
      .catch(() => {});
  }, []);
  useEffect(refresh, [refresh, location.pathname]);
  useEffect(() => {
    const timer = setInterval(refresh, 60000);
    window.addEventListener(NOTIFICATIONS_CHANGED, refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener(NOTIFICATIONS_CHANGED, refresh);
    };
  }, [refresh]);
  return count;
}

function SideNav({ sections, unread, onNavigate }) {
  const { t } = useLanguage();
  return (
    <nav className="flex flex-col gap-1" aria-label="Workspace">
      {sections.map((section, i) => (
        <div key={section.title || i} className={i > 0 ? 'mt-4' : ''}>
          {section.title && <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{section.title}</p>}
          {section.items.map(({ to, label, icon: Icon, end, badge }) => {
            const count = badge === 'unread' ? unread : badge;
            return (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={onNavigate}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${isActive ? 'bg-royal text-white' : 'text-slate-300 hover:bg-white/10 hover:text-white'}`
                }
              >
                <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                <span className="flex-1">{label}</span>
                {count > 0 && <span className="rounded-full bg-critical px-2 py-0.5 text-xs font-semibold text-white">{count > 99 ? '99+' : count}</span>}
              </NavLink>
            );
          })}
        </div>
      ))}
      <div className="my-3 border-t border-white/10" />
      <NavLink to="/explore" onClick={onNavigate} className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 hover:bg-white/10 hover:text-white">
        <Globe2 className="h-5 w-5" aria-hidden="true" />
        {t('nav.explore')}
      </NavLink>
    </nav>
  );
}

/**
 * @param {object} props
 * @param {string} props.homePath   e.g. /citizen
 * @param {Array<{ title?: string, items: Array<{ to, label, icon, end?, badge? }> }>} props.sections
 *        badge: a number, or 'unread' for the notification count
 * @param {string} props.notificationsPath
 * @param {string} props.settingsPath
 * @param {string} [props.wide] wider content area (admin tables)
 */
export default function WorkspaceLayout({ homePath, sections, notificationsPath, settingsPath, wide = false }) {
  const { t } = useLanguage();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const unread = useUnreadCount();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // Leave the protected area first, so the route guard does not redirect to /login.
  const signOut = () => {
    navigate('/', { replace: true });
    logout();
  };
  const initials = (user.fullName || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

  const sidebar = (
    <div className="flex h-full flex-col bg-navy px-4 py-5">
      <div className="px-1">
        <Logo light to={homePath} />
      </div>
      <div className="mt-8 flex-1 overflow-y-auto">
        <SideNav sections={sections} unread={unread} onNavigate={() => setMenuOpen(false)} />
      </div>
      <button type="button" onClick={signOut} className="mt-4 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 hover:bg-white/10 hover:text-white">
        <LogOut className="h-5 w-5" aria-hidden="true" />
        {t('nav.logout')}
      </button>
    </div>
  );

  return (
    <div className="min-h-screen lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">{sidebar}</aside>

      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-navy/60" onClick={() => setMenuOpen(false)} aria-hidden="true" />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-xl">
            {sidebar}
            <button type="button" onClick={() => setMenuOpen(false)} className="absolute right-3 top-5 rounded-md p-1.5 text-slate-300 hover:bg-white/10" aria-label={t('common.close')}>
              <X className="h-5 w-5" />
            </button>
          </aside>
        </div>
      )}

      <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-line bg-white/95 px-4 backdrop-blur-sm sm:px-6">
        <div className="flex items-center gap-2">
          <button type="button" className="rounded-lg p-2 text-ink hover:bg-page lg:hidden" onClick={() => setMenuOpen(true)} aria-label={t('nav.menu')}>
            <Menu className="h-6 w-6" />
          </button>
          <span className="hidden rounded-full bg-royal-50 px-2.5 py-1 text-xs font-semibold text-royal-700 sm:inline-block">{t(`roles.${user.role}`)}</span>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <LanguageSwitch />
          <Link to={notificationsPath} className="relative rounded-lg p-2 text-muted hover:bg-page hover:text-ink" aria-label={`${t('nav.notifications')}${unread ? ` (${unread} ${t('notifications.unread')})` : ''}`}>
            <Bell className="h-5 w-5" />
            {unread > 0 && <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-critical ring-2 ring-white" />}
          </Link>
          <Link to={settingsPath} className="flex items-center gap-2 rounded-lg p-1 pr-2 hover:bg-page" aria-label={t('nav.myAccount')}>
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-royal text-xs font-bold text-white">{initials}</span>
            <span className="hidden max-w-36 truncate text-sm font-medium text-ink md:block">{user.fullName}</span>
          </Link>
        </div>
      </header>

      <main className={`mx-auto px-4 py-6 sm:px-6 lg:px-8 lg:py-8 ${wide ? 'max-w-7xl' : 'max-w-6xl'}`}>
        <Outlet />
      </main>
    </div>
  );
}
