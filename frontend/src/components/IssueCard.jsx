/** A public issue (GET /api/public/issues item) as a card linking to its page. */
import { Link } from 'react-router-dom';
import { ArrowUpRight, ThumbsUp, Users } from 'lucide-react';
import CategoryIcon from './CategoryIcon';
import { StatusBadge } from './ui/badges';
import { useLanguage } from '../i18n/LanguageContext';

export default function IssueCard({ issue }) {
  const { t, categoryName, formatDate } = useLanguage();
  return (
    <Link
      to={`/issues/${issue.referenceNumber}`}
      className="group flex h-full flex-col rounded-xl border border-line bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-shadow hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-royal-50 text-royal">
          <CategoryIcon code={issue.category.code} />
        </span>
        <StatusBadge status={issue.status} />
      </div>
      <p className="mt-3 font-semibold text-ink">{categoryName(issue.category)}</p>
      <p className="text-sm text-muted">
        {issue.district.name}, {issue.district.city}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 pt-4 text-xs text-muted">
        <span className="font-mono font-medium text-navy">{issue.referenceNumber}</span>
        <span>{formatDate(issue.reportedAt)}</span>
        <span className="inline-flex items-center gap-1">
          <Users className="h-3.5 w-3.5" aria-hidden="true" />
          {issue.reportCount === 1 ? t('common.report1') : t('common.reports', { count: issue.reportCount })}
        </span>
        {issue.upvoteCount > 0 && (
          <span className="inline-flex items-center gap-1">
            <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" />
            {issue.upvoteCount}
          </span>
        )}
        <ArrowUpRight className="ml-auto h-4 w-4 text-royal opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
      </div>
    </Link>
  );
}
