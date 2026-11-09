/**
 * One of the citizen's reports:
 *   GET /api/issues/:id/status   status, SLA, history, canReopen
 *   GET /api/issues/:id/photos   before / after / own reopen photos
 *   GET /api/issues/mine         category, district, own report and rating
 *   GET /api/public/issues/:ref  location and upvotes (not for sensitive issues)
 * Actions: reopen (resolved, within 7 days, photo required), rate the fix
 * (resolved or closed), "Me too" on open public issues.
 */
import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, EyeOff, RotateCcw, SearchX, Star } from 'lucide-react';
import Button from '../../components/ui/Button';
import { Alert, Card, EmptyState, LoadError, TextArea } from '../../components/ui/primitives';
import { PageSpinner } from '../../components/ui/Spinner';
import { SlaBadge, StatusBadge } from '../../components/ui/badges';
import CategoryIcon from '../../components/CategoryIcon';
import { BeforeAfter, PhotoGrid, PhotoPicker, validatePhotos } from '../../components/photos';
import { PointMap, STATUS_COLORS } from '../../components/maps';
import UpvoteButton from '../../components/UpvoteButton';
import { issueApi, publicApi } from '../../api/services';
import useAsync from '../../hooks/useAsync';
import { useLanguage } from '../../i18n/LanguageContext';
import { charLength } from '../../utils/validation';
import { LIMITS } from '../../config';

/** Finds the citizen's own entry for this issue in /issues/mine (100 per page). */
async function findMine(issueId) {
  for (let offset = 0; ; offset += 100) {
    const page = await issueApi.mine({ limit: 100, offset });
    const hit = page.issues.find((i) => i.id === Number(issueId));
    if (hit) return hit;
    if (offset + 100 >= page.pagination.total) return null;
  }
}

async function loadAll(id, mineFromState) {
  const [status, photos, mine] = await Promise.all([issueApi.status(id), issueApi.photos(id), mineFromState ? Promise.resolve(mineFromState) : findMine(id)]);
  let pub = null;
  try {
    pub = (await publicApi.issue(status.issue.referenceNumber)).issue;
  } catch {
    pub = null; // sensitive issues are not public
  }
  return { status, photos: photos.photos, mine, pub };
}

export default function ReportDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const { t } = useLanguage();
  const fromState = location.state?.mine && location.state.mine.id === Number(id) ? location.state.mine : null;
  const { data, loading, error, reload, setData } = useAsync(() => loadAll(id, fromState), [id]);

  return (
    <div>
      <Link to="/citizen/reports" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('nav.myReports')}
      </Link>
      <div className="mt-4">
        {loading ? (
          <PageSpinner />
        ) : error ? (
          error.code === 'ISSUE_NOT_FOUND' || error.code === 'VALIDATION_ERROR' ? (
            <EmptyState icon={SearchX} title={t('errors.ISSUE_NOT_FOUND')} action={<Button to="/citizen/reports">{t('nav.myReports')}</Button>} />
          ) : (
            <LoadError error={error} onRetry={reload} />
          )
        ) : (
          <Detail data={data} reload={reload} setData={setData} />
        )}
      </div>
    </div>
  );
}

function Detail({ data, reload, setData }) {
  const { t, categoryName, formatDate } = useLanguage();
  const { status, photos, mine, pub } = data;
  const issue = status.issue;
  const canRate = issue.status === 'resolved' || issue.status === 'closed';

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card className="p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-4">
              {mine && (
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-royal-50 text-royal">
                  <CategoryIcon code={mine.category.code} className="h-6 w-6" />
                </span>
              )}
              <div>
                <p className="font-mono text-sm font-semibold text-navy">{issue.referenceNumber}</p>
                <h1 className="mt-0.5 text-xl font-bold">{mine ? categoryName(mine.category) : issue.referenceNumber}</h1>
                {mine && (
                  <p className="text-sm text-muted">
                    {mine.district.name}, {mine.district.city}
                  </p>
                )}
              </div>
            </div>
            <StatusBadge status={issue.status} subStatus={issue.subStatus} />
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-5">
            <span className="text-sm font-medium text-muted">{t('issue.slaTitle')}:</span>
            <SlaBadge sla={issue.sla} />
            <span className="text-xs text-muted">{t('issue.dueAt', { date: formatDate(issue.sla.dueAt, true) })}</span>
          </div>
          {mine && (
            <div className="mt-5 rounded-lg bg-page p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                {t('citizen.myReport')} · {mine.myReport.isOriginal ? t('citizen.original') : t('citizen.merged')}
              </p>
              <p className="mt-1.5 whitespace-pre-line text-sm text-ink">{mine.myReport.description}</p>
              <p className="mt-2 text-xs text-muted">{formatDate(mine.myReport.reportedAt, true)}</p>
            </div>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="text-base font-semibold">{t('publicIssue.photosTitle')}</h2>
          <div className="mt-4">
            <BeforeAfter before={photos.before} after={photos.after} />
          </div>
          {photos.reopen?.length > 0 && (
            <div className="mt-6">
              <p className="mb-2 text-sm font-semibold">{t('issue.reopenPhotos')}</p>
              <PhotoGrid photos={photos.reopen} alt={t('issue.reopenPhotos')} />
            </div>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="text-base font-semibold">{t('issue.history')}</h2>
          <History entries={status.history} />
        </Card>
      </div>

      <div className="space-y-6">
        {issue.canReopen && <ReopenForm issue={issue} onDone={reload} />}
        {canRate && <RatingForm issueId={issue.id} mine={mine} onSaved={(rating) => setData((d) => ({ ...d, mine: d.mine && { ...d.mine, myReport: { ...d.mine.myReport, ...rating } } }))} />}
        {pub ? (
          <>
            <Card className="p-6">
              <p className="mb-3 text-sm font-semibold">{t('issue.community')}</p>
              <UpvoteButton referenceNumber={issue.referenceNumber} status={issue.status} initialCount={pub.upvoteCount} />
            </Card>
            <Card className="p-2">
              <p className="px-3 pb-2 pt-2 text-sm font-semibold">{t('publicIssue.location')}</p>
              <PointMap latitude={pub.location.latitude} longitude={pub.location.longitude} color={STATUS_COLORS[issue.status]} className="h-64" />
            </Card>
          </>
        ) : (
          <Card className="flex items-center gap-3 p-5 text-sm text-muted">
            <EyeOff className="h-5 w-5 shrink-0" aria-hidden="true" />
            {t('issue.notPublic')}
          </Card>
        )}
      </div>
    </div>
  );
}

function History({ entries }) {
  const { t, formatDate } = useLanguage();
  if (!entries.length) return <p className="mt-3 text-sm text-muted">{t('issue.noHistory')}</p>;
  const who = (e) => {
    if (!e.changedBy) return t('issue.system');
    if (e.changedBy.isYou) return t('issue.you');
    return t(`issue.${e.changedBy.role}`);
  };
  return (
    <ol className="relative mt-5 space-y-6 border-l-2 border-line pl-6">
      {entries.map((e) => (
        <li key={e.id} className="relative">
          <span
            className="absolute -left-[31px] top-1 h-3.5 w-3.5 rounded-full ring-4 ring-white"
            style={{ backgroundColor: STATUS_COLORS[e.toStatus] || '#64748B' }}
            aria-hidden="true"
          />
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={e.toStatus} subStatus={e.toSubStatus} />
            {e.isReopen && <span className="text-xs font-semibold text-critical">{t('issue.reopened')}</span>}
          </div>
          {e.comment && <p className="mt-1.5 text-sm text-ink">{e.comment}</p>}
          <p className="mt-1 text-xs text-muted">
            {formatDate(e.createdAt, true)} · {t('issue.by', { who: who(e) })}
          </p>
        </li>
      ))}
    </ol>
  );
}

function ReopenForm({ issue, onDone }) {
  const { t, errorMessage, formatDate } = useLanguage();
  const [comment, setComment] = useState('');
  const [photos, setPhotos] = useState([]);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    const next = {};
    const len = charLength(comment.trim());
    if (len < LIMITS.commentMin || len > LIMITS.commentMax) next.comment = t('validation.commentLength');
    const photoErrors = validatePhotos(photos, t);
    if (photoErrors.length) next.photos = photoErrors.join(' ');
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setServerError(null);
    try {
      await issueApi.reopen(issue.id, { comment: comment.trim(), photos });
      await onDone();
    } catch (err) {
      setServerError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-warning/40 p-6">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <RotateCcw className="h-5 w-5 text-amber-600" aria-hidden="true" />
        {t('issue.reopenTitle')}
      </h2>
      <p className="mt-1 text-sm text-muted">{t('issue.reopenText', { date: formatDate(issue.reopenDeadline, true) })}</p>
      <form onSubmit={submit} noValidate className="mt-4 space-y-4">
        {serverError && <Alert tone="error">{errorMessage(serverError)}</Alert>}
        <TextArea label={t('issue.reopenComment')} rows={3} maxLength={LIMITS.commentMax} value={comment} onChange={(e) => setComment(e.target.value)} error={errors.comment} />
        <PhotoPicker files={photos} onChange={setPhotos} error={errors.photos} />
        <Button type="submit" variant="navy" className="w-full" loading={busy}>
          {t('issue.reopenButton')}
        </Button>
      </form>
    </Card>
  );
}

function RatingForm({ issueId, mine, onSaved }) {
  const { t, errorMessage } = useLanguage();
  const current = mine?.myReport.fixRating ?? null;
  const [value, setValue] = useState(current || 0);
  const [hover, setHover] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const save = async (rating) => {
    setValue(rating);
    setBusy(true);
    setMessage(null);
    try {
      const { rating: saved } = await issueApi.rate(issueId, rating);
      onSaved(saved);
      setMessage({ tone: 'success', text: t('issue.ratingSaved') });
    } catch (err) {
      setValue(current || 0);
      setMessage({ tone: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const shown = hover || value;
  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold">{t('issue.ratingTitle')}</h2>
      <p className="mt-1 text-sm text-muted">{t('issue.ratingText')}</p>
      <div className="mt-4 flex gap-1" role="radiogroup" aria-label={t('issue.ratingTitle')} onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n}/5`}
            disabled={busy}
            onMouseEnter={() => setHover(n)}
            onClick={() => save(n)}
            className="rounded-md p-1 disabled:opacity-60"
          >
            <Star className={`h-8 w-8 ${n <= shown ? 'fill-warning text-warning' : 'text-line'}`} />
          </button>
        ))}
      </div>
      {value > 0 && <p className="mt-2 text-sm text-muted">{t('issue.yourRating', { n: value })}</p>}
      {message && (
        <Alert tone={message.tone} className="mt-3">
          {message.text}
        </Alert>
      )}
    </Card>
  );
}
