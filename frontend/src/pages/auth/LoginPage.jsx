/** POST /api/auth/login with phone number + password; then the role's home. */
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import AuthShell from './AuthShell';
import PasswordField from './PasswordField';
import Button from '../../components/ui/Button';
import { Alert, TextField } from '../../components/ui/primitives';
import { useAuth, homeForRole } from '../../auth/AuthContext';
import { useLanguage } from '../../i18n/LanguageContext';
import { isPhone, normalizePhone } from '../../utils/validation';

export default function LoginPage() {
  const { t, errorMessage } = useLanguage();
  const { login, sessionExpired, clearSessionExpired } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ phoneNumber: '', password: '' });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const next = {};
    if (!isPhone(form.phoneNumber)) next.phoneNumber = t('validation.phone');
    if (!form.password) next.password = t('validation.required');
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setServerError(null);
    try {
      const user = await login(normalizePhone(form.phoneNumber), form.password);
      clearSessionExpired();
      // Go back to the page that asked for login only if this role may use it.
      const from = location.state?.from;
      const workspace = from && ['/citizen', '/officer', '/supervisor', '/admin'].find((p) => from === p || from.startsWith(`${p}/`));
      const allowed = from && (!workspace || workspace === homeForRole(user.role));
      navigate(allowed ? from : homeForRole(user.role), { replace: true });
    } catch (err) {
      setServerError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={t('auth.loginTitle')}
      subtitle={t('auth.loginSubtitle')}
      footer={
        <>
          {t('auth.noAccount')}{' '}
          <Link to="/register" className="font-semibold text-royal hover:text-royal-700">
            {t('nav.register')}
          </Link>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="space-y-5">
        {sessionExpired && !serverError && <Alert tone="warning">{t('auth.sessionExpired')}</Alert>}
        {serverError && <Alert tone="error">{errorMessage(serverError)}</Alert>}
        <TextField
          label={t('auth.phone')}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+252 61 000 0301"
          value={form.phoneNumber}
          onChange={(e) => setForm({ ...form, phoneNumber: e.target.value })}
          error={errors.phoneNumber}
          hint={t('auth.phoneHint')}
        />
        <PasswordField
          label={t('auth.password')}
          autoComplete="current-password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          error={errors.password}
        />
        <Button type="submit" className="w-full" loading={busy}>
          {t('auth.loginButton')}
        </Button>
        <p className="text-center text-xs text-muted">{t('auth.staffNote')}</p>
      </form>
    </AuthShell>
  );
}
