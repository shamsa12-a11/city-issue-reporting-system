/**
 * An issue in a staff list (officer / supervisor / unassigned / escalation
 * lists all share this shape: id, referenceNumber, status, category,
 * district, sla, officer?, isSensitive).
 */
import { Link } from 'react-router-dom';
import { ChevronRight, EyeOff, UserRound } from 'lucide-react';
import CategoryIcon from '../CategoryIcon';
import { SlaBadge, StatusBadge } from '../ui/badges';
import { useLanguage } from '../../i18n/LanguageContext';
import { issuePathForRole, useAuth } from '../../auth/AuthContext';

export default function StaffIssueRow({ issue, action, extra }) {
  const { t, categoryName, formatDate } = useLanguage();
  const { user } = useAuth();
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-white p-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
      <Link to={issuePathForRole(user.role, issue.id)} className="flex min-w-0 items-start gap-4">
        <span className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-royal-50 text-royal sm:flex">
          <CategoryIcon code={issue.category.code} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-sm font-semibold text-navy">{issue.referenceNumber}</span>
            <span className="text-sm font-medium text-ink">{categoryName(issue.category)}</span>
            {issue.isSensitive && (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-muted">
                <EyeOff className="h-3 w-3" aria-hidden="true" />
                {t('staffCommon.sensitive')}
              </span>
            )}
          </div>
          {issue.description && <p className="mt-1 line-clamp-1 text-sm text-muted">{issue.description}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={issue.status} subStatus={issue.subStatus} />
            {issue.sla && issue.status !== 'closed' && <SlaBadge sla={issue.sla} />}
            <span className="text-xs text-muted">
              {issue.district.name} · {formatDate(issue.createdAt)}
            </span>
            {'officer' in issue && (
              <span className="inline-flex items-center gap-1 text-xs text-muted">
                <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
                {issue.officer ? issue.officer.name : t('staffCommon.unassignedOfficer')}
              </span>
            )}
          </div>
        </div>
        {!action && <ChevronRight className="hidden h-5 w-5 shrink-0 self-center text-muted sm:block" aria-hidden="true" />}
      </Link>
      {/* Outside the row link, so it may contain links of its own. */}
      {extra && <div className="sm:pl-15">{extra}</div>}
      </div>
      {action && <div className="flex shrink-0 gap-2">{action}</div>}
    </div>
  );
}

/** Client-side filter of the current page (the backend lists have no text search). */
export function matchesSearch(issue, query, categoryName) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [issue.referenceNumber, issue.description, categoryName(issue.category), issue.district?.name, issue.officer?.name]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(q));
}
