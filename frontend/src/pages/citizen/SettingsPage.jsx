/**
 * PATCH /api/auth/me/preferences: SMS on/off and preferred language (the
 * only two settings the backend allows; in-app notifications cannot be
 * turned off).
 */
import { useState } from 'react';
import Button from '../../components/ui/Button';
import { Alert, Card } from '../../components/ui/primitives';
import { useAuth } from '../../auth/AuthContext';
import { LANGUAGES, useLanguage } from '../../i18n/LanguageContext';

export default function SettingsPage() {
  const { t, errorMessage, setLanguage } = useLanguage();
  const { user, updatePreferences } = useAuth();
  const [sms, setSms] = useState(user.smsNotificationsEnabled);
  const [lang, setLang] = useState(user.preferredLanguage);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const dirty = sms !== user.smsNotificationsEnabled || lang !== user.preferredLanguage;

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const changes = {};
      if (sms !== user.smsNotificationsEnabled) changes.smsNotificationsEnabled = sms;
      if (lang !== user.preferredLanguage) changes.preferredLanguage = lang;
      await updatePreferences(changes);
      setLanguage(lang);
      setMessage({ tone: 'success', key: 'settings.saved' }); // shown in the new language
    } catch (err) {
      setMessage({ tone: 'error', error: err });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold">{t('settings.title')}</h1>
      <p className="mt-1 text-sm text-muted">{t('settings.subtitle')}</p>

      <Card className="mt-6 p-6">
        <h2 className="text-base font-semibold">{t('settings.profile')}</h2>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">{t('auth.fullName')}</dt>
            <dd className="mt-0.5 font-medium">{user.fullName}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t('auth.phone')}</dt>
            <dd className="mt-0.5 font-mono font-medium">{user.phoneNumber}</dd>
          </div>
        </dl>
      </Card>

      <form onSubmit={save}>
        <Card className="mt-6 divide-y divide-line">
          {user.role === 'citizen' && (
          <label className="flex cursor-pointer items-start justify-between gap-6 p-6">
            <span>
              <span className="block text-sm font-semibold">{t('settings.smsLabel')}</span>
              <span className="mt-1 block text-sm text-muted">{t('settings.smsHelp')}</span>
            </span>
            <span className="relative mt-1 inline-flex shrink-0">
              <input type="checkbox" role="switch" className="peer sr-only" checked={sms} onChange={(e) => setSms(e.target.checked)} />
              <span className="h-6 w-11 rounded-full bg-line transition-colors peer-checked:bg-royal peer-focus-visible:ring-2 peer-focus-visible:ring-royal peer-focus-visible:ring-offset-2" />
              <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
            </span>
          </label>
          )}
          <fieldset className="p-6">
            <legend className="text-sm font-semibold">{t('settings.languageLabel')}</legend>
            <p className="mt-1 text-sm text-muted">{t('settings.languageHelp')}</p>
            <div className="mt-3 flex gap-3">
              {LANGUAGES.map((l) => (
                <label key={l.code} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium ${lang === l.code ? 'border-royal bg-royal-50 text-royal-700' : 'border-line'}`}>
                  <input type="radio" name="language" value={l.code} checked={lang === l.code} onChange={() => setLang(l.code)} className="text-royal focus:ring-royal" />
                  {l.label}
                </label>
              ))}
            </div>
          </fieldset>
        </Card>
        {message && (
          <Alert tone={message.tone} className="mt-4">
            {message.key ? t(message.key) : errorMessage(message.error)}
          </Alert>
        )}
        <div className="mt-4 flex justify-end">
          <Button type="submit" loading={busy} disabled={!dirty}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </div>
  );
}
