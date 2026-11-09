/**
 * Public issue page (Feature 10 + Feature 8): only the public fields, the
 * location on a map and before / after photos side by side. Unknown and
 * sensitive issues both show "not found".
 */
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, MapPin, SearchX, Users } from 'lucide-react';
import { Card, EmptyState, LoadError } from '../../components/ui/primitives';
import { PageSpinner } from '../../components/ui/Spinner';
import { StatusBadge } from '../../components/ui/badges';
import CategoryIcon from '../../components/CategoryIcon';
import { BeforeAfter } from '../../components/photos';
import { PointMap, STATUS_COLORS } from '../../components/maps';
import UpvoteButton from '../../components/UpvoteButton';
import Button from '../../components/ui/Button';
import { publicApi } from '../../api/services';
import useAsync from '../../hooks/useAsync';
import { useLanguage } from '../../i18n/LanguageContext';

export default function PublicIssuePage() {
  const { referenceNumber } = useParams();
  const { t, categoryName, formatDate } = useLanguage();
  const { data, loading, error, reload } = useAsync(() => publicApi.issue(referenceNumber), [referenceNumber]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <Link to="/explore" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('nav.explore')}
      </Link>

      {loading ? (
        <PageSpinner />
      ) : error ? (
        error.code === 'ISSUE_NOT_FOUND' || error.code === 'VALIDATION_ERROR' ? (
          <EmptyState className="mt-6" icon={SearchX} title={t('publicIssue.notFound')} action={<Button to="/explore">{t('nav.explore')}</Button>} />
        ) : (
          <div className="mt-6">
            <LoadError error={error} onRetry={reload} />
          </div>
        )
      ) : (
        <IssueView issue={data.issue} t={t} categoryName={categoryName} formatDate={formatDate} />
      )}
    </div>
  );
}

function IssueView({ issue, t, categoryName, formatDate }) {
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card className="p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-4">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-royal-50 text-royal">
                <CategoryIcon code={issue.category.code} className="h-6 w-6" />
              </span>
              <div>
                <p className="font-mono text-sm font-semibold text-navy">{issue.referenceNumber}</p>
                <h1 className="mt-0.5 text-xl font-bold sm:text-2xl">{categoryName(issue.category)}</h1>
              </div>
            </div>
            <StatusBadge status={issue.status} />
          </div>
          <dl className="mt-6 grid gap-4 border-t border-line pt-5 text-sm sm:grid-cols-3">
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted" aria-hidden="true" />
              <div>
                <dt className="text-xs text-muted">{t('common.district')}</dt>
                <dd className="font-medium">
                  {issue.district.name}, {issue.district.city}
                </dd>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-muted" aria-hidden="true" />
              <div>
                <dt className="text-xs text-muted">{t('common.date')}</dt>
                <dd className="font-medium">{formatDate(issue.reportedAt)}</dd>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted" aria-hidden="true" />
              <div>
                <dt className="text-xs text-muted">{t('common.reportCount')}</dt>
                <dd className="font-medium">{issue.reportCount === 1 ? t('common.report1') : t('common.reports', { count: issue.reportCount })}</dd>
              </div>
            </div>
          </dl>
        </Card>

        <Card className="p-6">
          <h2 className="text-base font-semibold">{t('publicIssue.photosTitle')}</h2>
          <div className="mt-4">
            <BeforeAfter before={issue.photos.before} after={issue.photos.after} />
          </div>
        </Card>
      </div>

      <div className="space-y-6">
        <Card className="p-6">
          <UpvoteButton referenceNumber={issue.referenceNumber} status={issue.status} initialCount={issue.upvoteCount} />
        </Card>
        <Card className="p-2">
          <p className="px-3 pb-2 pt-2 text-sm font-semibold">{t('publicIssue.location')}</p>
          <PointMap latitude={issue.location.latitude} longitude={issue.location.longitude} color={STATUS_COLORS[issue.status]} className="h-72" />
        </Card>
      </div>
    </div>
  );
}
