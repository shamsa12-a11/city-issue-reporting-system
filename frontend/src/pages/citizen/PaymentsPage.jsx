/**
 * Simulated mobile money (brief §6.6): EVC Plus, Zaad, eDahab.
 * POST /api/payments starts a pending payment; confirmation and the receipt
 * are on the payment page. No real money moves.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight, CreditCard, ShieldAlert, Smartphone } from 'lucide-react';
import Button from '../../components/ui/Button';
import { Alert, Card, EmptyState, LoadError, Pagination, SelectField, TextField } from '../../components/ui/primitives';
import { PageSpinner } from '../../components/ui/Spinner';
import { PaymentStatusBadge } from '../../components/ui/badges';
import { issueApi, paymentApi } from '../../api/services';
import useAsync from '../../hooks/useAsync';
import { useAuth } from '../../auth/AuthContext';
import { useLanguage } from '../../i18n/LanguageContext';
import { charLength, isSomaliMobile, normalizePhone } from '../../utils/validation';

export const PROVIDERS = [
  { code: 'evc_plus', name: 'EVC Plus' },
  { code: 'zaad', name: 'Zaad' },
  { code: 'edahab', name: 'eDahab' },
];

function NewPayment() {
  const { t, errorMessage, categoryName } = useLanguage();
  const { user } = useAuth();
  const navigate = useNavigate();
  const myIssues = useAsync(() => issueApi.mine({ limit: 100 }), []);
  const [form, setForm] = useState({ provider: 'evc_plus', phoneNumber: user.phoneNumber, amount: '', currency: 'USD', purpose: '', issueId: '' });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    const next = {};
    if (!isSomaliMobile(form.phoneNumber)) next.phoneNumber = t('validation.somaliPhone');
    const amount = form.amount.trim();
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > 1000000) next.amount = t('validation.amount');
    const purposeLen = charLength(form.purpose.trim());
    if (purposeLen < 3 || purposeLen > 200) next.purpose = t('validation.purpose');
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setServerError(null);
    try {
      const body = { provider: form.provider, phoneNumber: normalizePhone(form.phoneNumber), amount, currency: form.currency, purpose: form.purpose.trim() };
      if (form.issueId) body.issueId = Number(form.issueId);
      const { payment } = await paymentApi.create(body);
      navigate(`/citizen/payments/${payment.reference}`);
    } catch (err) {
      setServerError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold">{t('payments.newPayment')}</h2>
      <form onSubmit={submit} noValidate className="mt-5 space-y-5">
        {serverError && (
          <Alert tone="error">
            {errorMessage(serverError)}
            {serverError.code === 'PAYMENT_PENDING_EXISTS' && serverError.details?.paymentReference && (
              <Link to={`/citizen/payments/${serverError.details.paymentReference}`} className="ml-1 font-semibold underline">
                {t('payments.openPending')}
              </Link>
            )}
          </Alert>
        )}
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('payments.provider')}</legend>
          <div className="grid grid-cols-3 gap-3">
            {PROVIDERS.map((p) => (
              <label
                key={p.code}
                className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border p-3 text-center text-sm font-semibold transition-colors ${
                  form.provider === p.code ? 'border-royal bg-royal-50 text-royal-700 ring-1 ring-royal' : 'border-line hover:bg-page'
                }`}
              >
                <input type="radio" name="provider" value={p.code} checked={form.provider === p.code} onChange={set('provider')} className="sr-only" />
                <Smartphone className="h-5 w-5" aria-hidden="true" />
                {p.name}
              </label>
            ))}
          </div>
        </fieldset>
        <TextField label={t('payments.phone')} type="tel" inputMode="tel" value={form.phoneNumber} onChange={set('phoneNumber')} error={errors.phoneNumber} />
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <TextField label={t('payments.amount')} inputMode="decimal" placeholder="5.00" value={form.amount} onChange={set('amount')} error={errors.amount} />
          </div>
          <SelectField label={t('payments.currency')} value={form.currency} onChange={set('currency')}>
            <option value="USD">USD</option>
            <option value="SOS">SOS</option>
          </SelectField>
        </div>
        <TextField label={t('payments.purpose')} placeholder={t('payments.purposePlaceholder')} maxLength={200} value={form.purpose} onChange={set('purpose')} error={errors.purpose} />
        <SelectField label={t('payments.linkIssue')} optional value={form.issueId} onChange={set('issueId')} disabled={myIssues.loading || !!myIssues.error}>
          <option value="">{t('payments.noIssue')}</option>
          {(myIssues.data?.issues || []).map((i) => (
            <option key={i.myReport.id} value={i.id}>
              {i.referenceNumber} — {categoryName(i.category)}
            </option>
          ))}
        </SelectField>
        <Button type="submit" className="w-full" loading={busy}>
          {t('payments.start')}
        </Button>
      </form>
    </Card>
  );
}

function History() {
  const { t, formatDate } = useLanguage();
  const [offset, setOffset] = useState(0);
  const { data, loading, error, reload } = useAsync(() => paymentApi.list({ limit: 10, offset }), [offset]);
  if (loading) return <PageSpinner />;
  if (error) return <LoadError error={error} onRetry={reload} />;
  if (data.payments.length === 0) return <EmptyState icon={CreditCard} title={t('payments.empty')} />;
  return (
    <>
      <Card className="divide-y divide-line">
        {data.payments.map((p) => (
          <Link key={p.reference} to={`/citizen/payments/${p.reference}`} className="flex items-center gap-4 p-4 hover:bg-page">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold text-navy">{p.reference}</span>
                <PaymentStatusBadge status={p.status} />
              </div>
              <p className="mt-1 truncate text-sm text-muted">
                {p.provider.name} · {p.purpose}
              </p>
              <p className="mt-0.5 text-xs text-muted">{formatDate(p.createdAt, true)}</p>
            </div>
            <p className="whitespace-nowrap text-sm font-bold">
              {p.amount} {p.currency}
            </p>
            <ChevronRight className="h-5 w-5 text-muted" aria-hidden="true" />
          </Link>
        ))}
      </Card>
      <div className="mt-4">
        <Pagination pagination={data.pagination} onChange={setOffset} />
      </div>
    </>
  );
}

export default function PaymentsPage() {
  const { t } = useLanguage();
  return (
    <div>
      <h1 className="text-2xl font-bold">{t('payments.title')}</h1>
      <p className="mt-1 text-sm text-muted">{t('payments.subtitle')}</p>
      <Alert tone="warning" className="mt-5">
        <span className="inline-flex items-center gap-1.5">
          <ShieldAlert className="h-4 w-4" aria-hidden="true" />
          {t('payments.simulatedBanner')}
        </span>
      </Alert>
      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <NewPayment />
        </div>
        <section className="lg:col-span-3">
          <h2 className="mb-4 text-base font-semibold">{t('payments.history')}</h2>
          <History />
        </section>
      </div>
    </div>
  );
}
