/** One item of GET /api/issues/mine as a clickable row. */
import { Link } from 'react-router-dom';
import { ChevronRight, GitMerge, Star } from 'lucide-react';
import CategoryIcon from '../../components/CategoryIcon';
import { SlaBadge, StatusBadge } from '../../components/ui/badges';
import { useLanguage } from '../../i18n/LanguageContext';

export default function ReportRow({ issue }) {
  const { t, categoryName, formatDate } = useLanguage();
  return (
    <Link
      to={`/citizen/reports/${issue.id}`}
      state={{ mine: issue }}
      className="flex items-center gap-4 rounded-xl border border-line bg-white p-4 transition-shadow hover:shadow-md"
    >
      <span className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-royal-50 text-royal sm:flex">
        <CategoryIcon code={issue.category.code} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-sm font-semibold text-navy">{issue.referenceNumber}</span>
          <span className="text-sm font-medium text-ink">{categoryName(issue.category)}</span>
          {!issue.myReport.isOriginal && (
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <GitMerge className="h-3.5 w-3.5" aria-hidden="true" />
              {t('citizen.merged')}
            </span>
          )}
        </div>
        <p className="mt-1 truncate text-sm text-muted">{issue.myReport.description}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatusBadge status={issue.status} subStatus={issue.subStatus} />
          {issue.status !== 'closed' && <SlaBadge sla={issue.sla} showTime={false} />}
          {issue.myReport.fixRating && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
              <Star className="h-3.5 w-3.5 fill-warning text-warning" aria-hidden="true" />
              {issue.myReport.fixRating}/5
            </span>
          )}
          <span className="text-xs text-muted">
            {issue.district.name} · {formatDate(issue.myReport.reportedAt)}
          </span>
        </div>
      </div>
      <ChevronRight className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
    </Link>
  );
}
