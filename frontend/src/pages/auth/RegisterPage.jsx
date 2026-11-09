/** POST /api/auth/register (always a citizen account), then the citizen dashboard. */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AuthShell from './AuthShell';
import PasswordField from './PasswordField';
import Button from '../../components/ui/Button';
import { Alert, SelectField, TextField } from '../../components/ui/primitives';
import { useAuth } from '../../auth/AuthContext';
import { useLanguage } from '../../i18n/LanguageContext';
import { isName, isPhone, normalizePhone, passwordProblem, serverFieldErrors } from '../../utils/validation';

export default function RegisterPage() {
  const { t, errorMessage, language } = useLanguage();
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ fullName: '', phoneNumber: '', password: '', confirm: '', preferredLanguage: language });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    const next = {};
    if (!isName(form.fullName)) next.fullName = t('validation.nameLength');
    if (!isPhone(form.phoneNumber)) next.phoneNumber = t('validation.phone');
    const pw = passwordProblem(form.password);
    if (pw) next.password = t(pw);
    if (form.confirm !== form.password) next.confirm = t('validation.passwordMatch');
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setServerError(null);
    try {
      await register({
        fullName: form.fullName.trim(),
        phoneNumber: normalizePhone(form.phoneNumber),
        password: form.password,
        preferredLanguage: form.preferredLanguage,
      });
      navigate('/citizen', { replace: true });
    } catch (err) {
      setServerError(err);
      const fields = serverFieldErrors(err);
      if (Object.keys(fields).length) setErrors(fields);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={t('auth.registerTitle')}
      subtitle={t('auth.registerSubtitle')}
      footer={
        <>
          {t('auth.haveAccount')}{' '}
          <Link to="/login" className="font-semibold text-royal hover:text-royal-700">
            {t('nav.login')}
          </Link>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="space-y-5">
        {serverError && <Alert tone="error">{errorMessage(serverError)}</Alert>}
        <TextField label={t('auth.fullName')} autoComplete="name" value={form.fullName} onChange={set('fullName')} error={errors.fullName} maxLength={100} />
        <TextField
          label={t('auth.phone')}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+252 61 000 0301"
          value={form.phoneNumber}
          onChange={set('phoneNumber')}
          error={errors.phoneNumber}
          hint={t('auth.phoneHint')}
        />
        <PasswordField label={t('auth.password')} autoComplete="new-password" value={form.password} onChange={set('password')} error={errors.password} hint={t('auth.passwordHint')} />
        <PasswordField label={t('auth.confirmPassword')} autoComplete="new-password" value={form.confirm} onChange={set('confirm')} error={errors.confirm} />
        <SelectField label={t('auth.preferredLanguage')} value={form.preferredLanguage} onChange={set('preferredLanguage')}>
          <option value="so">Soomaali</option>
          <option value="en">English</option>
        </SelectField>
        <Button type="submit" className="w-full" loading={busy}>
          {t('auth.registerButton')}
        </Button>
      </form>
    </AuthShell>
  );
}
