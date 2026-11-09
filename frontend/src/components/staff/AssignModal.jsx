/**
 * Assign or reassign an officer (POST /api/issues/:id/assign, supervisor of
 * the issue's department). Officers come from GET /api/supervisor/workload
 * with their live open-issue counts; officers on leave or inactive cannot be
 * chosen (the backend refuses them too). Replacing an officer needs a reason.
 */
import { useState } from 'react';
import Button from '../ui/Button';
import { Alert, LoadError, Modal, TextArea } from '../ui/primitives';
import { PageSpinner } from '../ui/Spinner';
import { staffIssueApi, supervisorApi } from '../../api/services';
import useAsync from '../../hooks/useAsync';
import { useLanguage } from '../../i18n/LanguageContext';
import { charLength } from '../../utils/validation';

export default function AssignModal({ issue, currentOfficerId, onClose, onDone }) {
  const { t, errorMessage } = useLanguage();
  const workload = useAsync(() => supervisorApi.workload(), []);
  const [officerId, setOfficerId] = useState(null);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [busy, setBusy] = useState(false);
  const isReassign = currentOfficerId != null;

  const submit = async () => {
    const next = {};
    if (!officerId) next.officer = t('assign.choose');
    const len = charLength(reason.trim());
    if (isReassign && (len < 5 || len > 500)) next.reason = t('assign.reasonRequired');
    if (!isReassign && len > 0 && (len < 5 || len > 500)) next.reason = t('staffCommon.reasonHint');
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setServerError(null);
    try {
      const result = await staffIssueApi.assign(issue.id, { officerId, reason: reason.trim() || undefined });
      onDone(result);
    } catch (err) {
      setServerError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={`${isReassign ? t('assign.titleReassign') : t('assign.title')} · ${issue.referenceNumber}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={busy}>
            {isReassign ? t('supervisor.reassign') : t('supervisor.assign')}
          </Button>
        </>
      }
    >
      {serverError && (
        <Alert tone="error" className="mb-4">
          {errorMessage(serverError)}
        </Alert>
      )}
      {workload.loading ? (
        <PageSpinner />
      ) : workload.error ? (
        <LoadError error={workload.error} onRetry={workload.reload} />
      ) : workload.data.officers.length === 0 ? (
        <p className="text-sm text-muted">{t('supervisor.noOfficers')}</p>
      ) : (
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t('assign.officer')}</legend>
          <div className="space-y-2">
            {workload.data.officers.map((o) => {
              const available = o.isActive && !o.isOnLeave;
              const isCurrent = currentOfficerId != null && Number(currentOfficerId) === o.id;
              const disabled = !available || isCurrent;
              return (
                <label
                  key={o.id}
                  className={`flex items-center justify-between gap-3 rounded-lg border p-3 text-sm ${
                    disabled ? 'cursor-not-allowed border-line bg-page text-muted' : officerId === o.id ? 'cursor-pointer border-royal bg-royal-50 ring-1 ring-royal' : 'cursor-pointer border-line hover:bg-page'
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <input type="radio" name="officer" value={o.id} disabled={disabled} checked={officerId === o.id} onChange={() => setOfficerId(o.id)} className="text-royal focus:ring-royal" />
                    <span className="font-medium">{o.name}</span>
                    {o.isOnLeave && <span className="rounded-full bg-warning-50 px-2 py-0.5 text-xs text-amber-800">{t('supervisor.onLeave')}</span>}
                    {!o.isActive && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{t('staffCommon.inactive')}</span>}
                  </span>
                  <span className="whitespace-nowrap text-xs font-semibold">{t('assign.load', { count: o.openAssignedCount })}</span>
                </label>
              );
            })}
          </div>
          {errors.officer && <p className="mt-1.5 text-xs font-medium text-critical">{errors.officer}</p>}
        </fieldset>
      )}
      <div className="mt-4">
        <TextArea
          label={t('staffCommon.reason')}
          optional={!isReassign}
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={errors.reason}
          hint={isReassign ? t('assign.reasonRequired') : t('staffCommon.reasonHint')}
        />
      </div>
    </Modal>
  );
}
