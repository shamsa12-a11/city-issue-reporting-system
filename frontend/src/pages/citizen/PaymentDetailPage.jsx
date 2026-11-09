/**
 * One simulated payment: confirm with a simulated 4-digit PIN (never stored:
 * it lives only in this form and is cleared after sending), cancel, or view
 * and print the receipt.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Printer, SearchX, ShieldAlert, XCircle } from 'lucide-react';
import Button from '../../components/ui/Button';
import { Alert, Card, EmptyState, LoadError, TextField } from '../../components/ui/primitives';
import { PageSpinner } from '../../components/ui/Spinner';
import { PaymentStatusBadge } from '../../components/ui/badges';
import { LogoMark } from '../../components/Brand';
import { paymentApi } from '../../api/services';
import useAsync from '../../hooks/useAsync';
import { useLanguage } from '../../i18n/LanguageContext';

export default function PaymentDetailPage() {
  const { reference } = useParams();
  const { t } = useLanguage();
  const { data, loading, error, reload, setData } = useAsync(() => paymentApi.get(reference), [reference]);

  return (
    <div className="mx-auto max-w-2xl">
      <Link to="/citizen/payments" className="no-print inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('payments.title')}
      </Link>
      <div className="mt-4">
        {loading ? (
          <PageSpinner />
        ) : error ? (
          error.code === 'PAYMENT_NOT_FOUND' || error.code === 'VALIDATION_ERROR' ? (
            <EmptyState icon={SearchX} title={t('errors.PAYMENT_NOT_FOUND')} />
          ) : (
            <LoadError error={error} onRetry={reload} />
          )
        ) : data.payment.status === 'confirmed' && data.receipt ? (
          <Receipt receipt={data.receipt} />
        ) : data.payment.status === 'pending' ? (
          <ConfirmPayment payment={data.payment} onResult={setData} />
        ) : (
          <Outcome payment={data.payment} />
        )}
      </div>
    </div>
  );
}

function Summary({ payment }) {
  const { t } = useLanguage();
  return (
    <dl className="grid grid-cols-2 gap-4 rounded-lg bg-page p-4 text-sm">
      <div>
        <dt className="text-xs text-muted">{t('payments.paymentReference')}</dt>
        <dd className="font-mono font-semibold text-navy">{payment.reference}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted">{t('payments.amount')}</dt>
        <dd className="text-lg font-bold">
          {payment.amount} {payment.currency}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted">{t('payments.provider')}</dt>
        <dd className="font-medium">{payment.provider.name}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted">{t('payments.phone')}</dt>
        <dd className="font-mono font-medium">{payment.payerPhone}</dd>
      </div>
      <div className="col-span-2">
        <dt className="text-xs text-muted">{t('payments.purpose')}</dt>
        <dd className="font-medium">{payment.purpose}</dd>
      </div>
    </dl>
  );
}

function ConfirmPayment({ payment, onResult }) {
  const { t, errorMessage } = useLanguage();
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState(null);
  const [serverError, setServerError] = useState(null);
  const [busy, setBusy] = useState(null); // 'confirm' | 'cancel'

  const confirm = async (e) => {
    e.preventDefault();
    if (!/^\d{4}$/.test(pin)) {
      setPinError(t('validation.pin'));
      return;
    }
    setPinError(null);
    setServerError(null);
    setBusy('confirm');
    const entered = pin;
    setPin(''); // never kept after sending
    try {
      onResult(await paymentApi.confirm(payment.reference, entered));
    } catch (err) {
      setServerError(err);
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setServerError(null);
    setBusy('cancel');
    try {
      const { payment: cancelled } = await paymentApi.cancel(payment.reference);
      onResult({ payment: cancelled, receipt: null });
    } catch (err) {
      setServerError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">{t('payments.confirmTitle')}</h1>
        <PaymentStatusBadge status="pending" />
      </div>
      <p className="mt-1 text-sm text-muted">{t('payments.confirmText')}</p>
      <div className="mt-5">
        <Summary payment={payment} />
      </div>
      <Alert tone="warning" className="mt-5">
        <span className="inline-flex gap-1.5">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {t('payments.pinWarning')}
        </span>
      </Alert>
      <form onSubmit={confirm} noValidate className="mt-5 space-y-4">
        {serverError && <Alert tone="error">{errorMessage(serverError)}</Alert>}
        <TextField
          label={t('payments.pinLabel')}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          error={pinError}
          className="max-w-40 text-center font-mono text-lg tracking-[0.5em]"
        />
        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={busy === 'confirm'} disabled={busy === 'cancel'}>
            {t('payments.confirm')}
          </Button>
          <Button variant="secondary" onClick={cancel} loading={busy === 'cancel'} disabled={busy === 'confirm'}>
            {t('payments.cancelPayment')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Outcome({ payment }) {
  const { t } = useLanguage();
  const failed = payment.status === 'failed';
  return (
    <Card className="p-6 text-center">
      <span className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full ${failed ? 'bg-critical-50 text-critical' : 'bg-slate-100 text-muted'}`}>
        <XCircle className="h-7 w-7" aria-hidden="true" />
      </span>
      <h1 className="mt-4 text-xl font-bold">{failed ? t('payments.failed') : t('payments.cancelled')}</h1>
      {payment.failureReason && <p className="mt-1 text-sm text-critical">{payment.failureReason}</p>}
      <div className="mt-5 text-left">
        <Summary payment={payment} />
      </div>
      <Button to="/citizen/payments" className="mt-6">
        {t('payments.newPayment')}
      </Button>
    </Card>
  );
}

function Receipt({ receipt }) {
  const { t, language, formatDate } = useLanguage();
  const rows = [
    [t('payments.receiptNumber'), receipt.receiptNumber, true],
    [t('payments.paymentReference'), receipt.paymentReference, true],
    [t('payments.provider'), receipt.provider],
    [t('payments.paidBy'), `${receipt.payer.name} · ${receipt.payer.phoneNumber}`],
    [t('payments.purpose'), receipt.purpose],
    ...(receipt.issue ? [[t('payments.linkIssue'), receipt.issue.referenceNumber, true]] : []),
    [t('payments.transactionId'), receipt.transactionId, true],
    [t('payments.paidAt'), formatDate(receipt.confirmedAt, true)],
  ];
  return (
    <div>
      <Alert tone="success" className="no-print mb-4" title={t('payments.confirmed')} />
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 bg-navy px-6 py-5 text-white">
          <div className="flex items-center gap-3">
            <LogoMark className="h-9 w-9" />
            <div>
              <p className="text-sm font-bold tracking-wide">CODKA MAGAALADA</p>
              <p className="text-xs text-slate-300">{t('payments.receiptTitle')}</p>
            </div>
          </div>
          <CheckCircle2 className="h-7 w-7 text-success" aria-hidden="true" />
        </div>
        <div className="p-6">
          <p className="text-center text-3xl font-bold">
            {receipt.amount} <span className="text-lg text-muted">{receipt.currency}</span>
          </p>
          <dl className="mt-6 divide-y divide-line text-sm">
            {rows.map(([label, value, mono]) => (
              <div key={label} className="flex justify-between gap-4 py-2.5">
                <dt className="text-muted">{label}</dt>
                <dd className={`text-right font-medium ${mono ? 'break-all font-mono' : ''}`}>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-6 rounded-lg bg-warning-50 px-4 py-3 text-center text-xs text-amber-800">{language === 'so' ? receipt.note.so : receipt.note.en}</p>
        </div>
      </Card>
      <div className="no-print mt-4 flex flex-wrap justify-end gap-3">
        <Button variant="secondary" icon={Printer} onClick={() => window.print()}>
          {t('common.print')}
        </Button>
        <Button to="/citizen/payments">{t('payments.title')}</Button>
      </div>
    </div>
  );
}
