/**
 * "Me too" (Feature 11). Citizens only; the backend enforces one vote per
 * citizen, open issues only, and hides sensitive issues.
 */
import { useEffect, useState } from 'react';
import { ThumbsUp } from 'lucide-react';
import Button from './ui/Button';
import { publicApi } from '../api/services';
import { useAuth } from '../auth/AuthContext';
import { useLanguage } from '../i18n/LanguageContext';

const OPEN = ['new', 'assigned', 'in_progress'];

export default function UpvoteButton({ referenceNumber, status, initialCount, onCountChange }) {
  const { t, errorMessage } = useLanguage();
  const { isAuthenticated, user } = useAuth();
  const [state, setState] = useState({ upvoted: false, count: initialCount, checked: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const isCitizen = isAuthenticated && user.role === 'citizen';

  useEffect(() => {
    setState((s) => ({ ...s, count: initialCount }));
  }, [initialCount]);

  useEffect(() => {
    if (!isCitizen) return;
    let cancelled = false;
    publicApi
      .myUpvote(referenceNumber)
      .then((r) => !cancelled && setState({ upvoted: r.upvoted, count: r.upvoteCount, checked: true }))
      .catch(() => !cancelled && setState((s) => ({ ...s, checked: true })));
    return () => {
      cancelled = true;
    };
  }, [isCitizen, referenceNumber]);

  const vote = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await publicApi.upvote(referenceNumber);
      setState({ upvoted: true, count: r.upvoteCount, checked: true });
      onCountChange?.(r.upvoteCount);
    } catch (err) {
      if (err.code === 'ALREADY_UPVOTED') setState((s) => ({ ...s, upvoted: true }));
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const open = OPEN.includes(status);
  let hint = t('publicIssue.upvoteHelp');
  if (!isAuthenticated) hint = t('publicIssue.loginToUpvote');
  else if (!isCitizen) hint = t('publicIssue.staffCannotUpvote');
  else if (!open) hint = t('publicIssue.cannotUpvote');

  return (
    <div>
      <div className="flex items-center gap-3">
        {state.upvoted ? (
          <span className="inline-flex h-11 items-center gap-2 rounded-lg bg-success-50 px-4 text-sm font-semibold text-success">
            <ThumbsUp className="h-4 w-4" aria-hidden="true" />
            {t('publicIssue.upvoted')}
          </span>
        ) : !isAuthenticated ? (
          <Button to="/login" variant="secondary" icon={ThumbsUp}>
            {t('publicIssue.upvote')}
          </Button>
        ) : (
          <Button icon={ThumbsUp} onClick={vote} loading={busy} disabled={!isCitizen || !open}>
            {t('publicIssue.upvote')}
          </Button>
        )}
        <span className="text-sm font-semibold text-ink">{t('common.upvotes', { count: state.count ?? 0 })}</span>
      </div>
      <p className="mt-2 text-xs text-muted">{state.upvoted ? '' : hint}</p>
      {error && <p className="mt-1 text-xs font-medium text-critical">{error}</p>}
    </div>
  );
}
