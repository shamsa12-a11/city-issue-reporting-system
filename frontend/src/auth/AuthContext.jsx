/**
 * Session state using the backend's JWT (POST /auth/login, /auth/register;
 * GET /auth/me). Only the token is kept in localStorage; the user (and role)
 * is always read from the server, so a role change or a disabled account
 * takes effect at once.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authApi } from '../api/services';
import { setUnauthorizedHandler, tokenStore } from '../api/client';
import { useLanguage } from '../i18n/LanguageContext';

const AuthContext = createContext(null);

/** Where each role lands after logging in (also the URL prefix of its workspace). */
const HOMES = { citizen: '/citizen', officer: '/officer', supervisor: '/supervisor', admin: '/admin' };
export const homeForRole = (role) => HOMES[role] || '/';

/** Link to an issue inside the role's own workspace. */
export const issuePathForRole = (role, issueId) => (role === 'citizen' ? `/citizen/reports/${issueId}` : `${homeForRole(role)}/issues/${issueId}`);

export function AuthProvider({ children }) {
  const { setLanguage } = useLanguage();
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState(() => (tokenStore.get() ? 'loading' : 'anonymous'));
  const [sessionExpired, setSessionExpired] = useState(false);
  // true after the user pressed "Log out": guards then go home, not to /login.
  const [loggedOutByUser, setLoggedOutByUser] = useState(false);

  const endSession = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    setStatus('anonymous');
  }, []);

  const logout = useCallback(() => {
    setLoggedOutByUser(true);
    endSession();
  }, [endSession]);

  // A 401 on any request means the token is no longer valid.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSessionExpired(true);
      setLoggedOutByUser(false);
      endSession();
    });
  }, [endSession]);

  // Restore the session on first load.
  useEffect(() => {
    if (!tokenStore.get()) return;
    let cancelled = false;
    authApi
      .me()
      .then(({ user: me }) => {
        if (cancelled) return;
        setUser(me);
        setStatus('authenticated');
      })
      .catch(() => {
        if (cancelled) return;
        tokenStore.clear();
        setStatus('anonymous');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const startSession = useCallback(
    ({ token, user: sessionUser }) => {
      tokenStore.set(token);
      setUser(sessionUser);
      setStatus('authenticated');
      setSessionExpired(false);
      setLoggedOutByUser(false);
      if (sessionUser.preferredLanguage) setLanguage(sessionUser.preferredLanguage);
      return sessionUser;
    },
    [setLanguage]
  );

  const login = useCallback(async (phoneNumber, password) => startSession(await authApi.login(phoneNumber, password)), [startSession]);
  const register = useCallback(async (input) => startSession(await authApi.register(input)), [startSession]);

  /** Saves preferences (SMS on/off, language) and refreshes the user. */
  const updatePreferences = useCallback(async (prefs) => {
    const { user: updated } = await authApi.updatePreferences(prefs);
    setUser(updated);
    return updated;
  }, []);

  const value = useMemo(
    () => ({
      user,
      status,
      isAuthenticated: status === 'authenticated',
      sessionExpired,
      loggedOutByUser,
      clearSessionExpired: () => setSessionExpired(false),
      clearLoggedOut: () => setLoggedOutByUser(false),
      login,
      register,
      logout,
      updatePreferences,
    }),
    [user, status, sessionExpired, loggedOutByUser, login, register, logout, updatePreferences]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
