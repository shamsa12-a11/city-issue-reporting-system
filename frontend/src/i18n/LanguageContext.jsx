/**
 * Somali / English language state. The choice is remembered in the browser;
 * when the user is logged in it is also saved as their preferred language
 * (so new notifications and SMS follow it) by AuthContext.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import en from './en';
import so from './so';
import { LANGUAGE_STORAGE_KEY } from '../config';

const DICTIONARIES = { en, so };
export const LANGUAGES = [
  { code: 'so', label: 'Soomaali', short: 'SO' },
  { code: 'en', label: 'English', short: 'EN' },
];

const LanguageContext = createContext(null);

function initialLanguage() {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved === 'en' || saved === 'so') return saved;
  } catch {
    // ignore
  }
  return 'so';
}

/** Looks up "a.b.c" in a dictionary. */
const lookup = (dict, key) => key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), dict);

export function LanguageProvider({ children }) {
  const [language, setLanguageState] = useState(initialLanguage);

  const setLanguage = useCallback((code) => {
    if (code !== 'en' && code !== 'so') return;
    setLanguageState(code);
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const t = useCallback(
    (key, vars) => {
      let text = lookup(DICTIONARIES[language], key);
      if (text === undefined) text = lookup(en, key); // fall back to English
      if (typeof text !== 'string') return key;
      if (vars) text = text.replace(/\{(\w+)\}/g, (m, name) => (vars[name] !== undefined ? String(vars[name]) : m));
      return text;
    },
    [language]
  );

  /** Translates an ApiError (or anything) into a message for the user. */
  const errorMessage = useCallback(
    (error) => {
      const code = error && error.code;
      const known = code && lookup(DICTIONARIES[language], `errors.${code}`);
      return known || t('errors.UNKNOWN');
    },
    [language, t]
  );

  /** Category name in the current language. */
  const categoryName = useCallback((category) => (category ? (language === 'so' ? category.nameSo : category.nameEn) : ''), [language]);

  const formatDate = useCallback(
    (value, withTime = false) => {
      if (!value) return '';
      const options = withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' };
      return new Intl.DateTimeFormat(language === 'so' ? 'so-SO' : 'en-GB', options).format(new Date(value));
    },
    [language]
  );

  const value = useMemo(
    () => ({ language, setLanguage, t, errorMessage, categoryName, formatDate }),
    [language, setLanguage, t, errorMessage, categoryName, formatDate]
  );
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used inside LanguageProvider');
  return ctx;
}
