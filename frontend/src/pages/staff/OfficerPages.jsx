/**
 * Officer: dashboard and own issues (GET /api/officer/issues — current
 * assignments only, most urgent SLA first).
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ClipboardList, Lock, Search } from 'lucide-react';
import { Card, EmptyState, LoadError, Pagination, SectionHeading } from '../../components/ui/primitives';
import { PageSpinner, Spinner } from '../../components/ui/Spinner';
import StaffIssueRow, { matchesSearch } from '../../components/staff/StaffIssueRow';
import Tabs from '../../components/staff/Tabs';
import { officerApi } from '../../api/services';
import useAsync from '../../hooks/useAsync';
import { useAuth } from '../../auth/AuthContext';
import { useLanguage } from '../../i18n/LanguageContext';

async function loadOfficerOverview() {
  const count = (status) => officerApi.issues({ status, limit: 1 }).then((r) => r.pagination.total);
  const [open, resolved, closed, urgent] = await Promise.all([count('open'), count('resolved'), count('closed'), officerApi.issues({ status: 'open', limit: 100 })]);
  const overdue = urgent.issues.filter((i) => i.sla.state === 'breached').length;
  return { open, resolved, closed, overdue, urgent: urgent.issues.slice(0, 6) };
}

export function StatCard({ icon: Icon, label, value, tone = 'royal', loading }) {
  const tones = {
    royal: 'bg-royal-50 text-royal',
    amber: 'bg-warning-50 text-amber-700',
    green: 'bg-success-50 text-success',
    red: 'bg-critical-50 text-critical',
    slate: 'bg-slate-100 text-muted',
    navy: 'bg-slate-100 text-navy',
  };
  return (
    <Card className="p-5">
      <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${tones[tone]}`}>
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <p className="mt-4 text-2xl font-bold">{loading ? <Spinner /> : value ?? '—'}</p>
      <p className="text-sm text-muted">{label}</p>
    </Card>
  );
}

export function OfficerDashboard() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const { data, loading, error, reload } = useAsync(loadOfficerOverview, []);
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">{t('citizen.welcome', { name: user.fullName.split(' ')[0] })}</h1>
        <p className="mt-1 text-sm text-muted">
          {t('officer.subtitle')} {user.department && `· ${user.department.name}`}
        </p>
      </div>
      {error ? (
        <LoadError error={error} onRetry={reload} />
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard icon={ClipboardList} label={t('officer.statOpen')} value={data?.open} loading={loading} />
          <StatCard icon={AlertTriangle} label={t('officer.statOverdue')} value={data?.overdue} tone="red" loading={loading} />
          <StatCard icon={CheckCircle2} label={t('officer.statResolved')} value={data?.resolved} tone="green" loading={loading} />
          <StatCard icon={Lock} label={t('officer.statClosed')} value={data?.closed} tone="slate" loading={loading} />
        </div>
      )}
      <section>
        <SectionHeading title={t('officer.urgent')} />
        <div className="mt-4 space-y-3">
          {loading ? (
            <PageSpinner />
          ) : error ? null : data.urgent.length === 0 ? (
            <EmptyState icon={ClipboardList} title={t('officer.empty')} />
          ) : (
            data.urgent.map((issue) => <StaffIssueRow key={issue.id} issue={issue} />)
          )}
        </div>
      </section>
    </div>
  );
}

const OFFICER_TABS = ['open', 'resolved', 'closed', 'all'];

export function OfficerIssuesPage() {
  const { t, categoryName } = useLanguage();
  const [params, setParams] = useSearchParams();
  const status = OFFICER_TABS.includes(params.get('status')) ? params.get('status') : 'open';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const [search, setSearch] = useState('');
  const { data, loading, error, reload } = useAsync(() => officerApi.issues({ status, limit: 20, offset }), [status, offset]);
  const issues = (data?.issues || []).filter((i) => matchesSearch(i, search, categoryName));
  return (
    <div>
      <h1 className="text-2xl font-bold">{t('officer.issuesTitle')}</h1>
      <p className="mt-1 text-sm text-muted">{t('officer.subtitle')}</p>
      <Tabs
        value={status}
        onChange={(s) => setParams(s === 'open' ? {} : { status: s }, { replace: true })}
        tabs={OFFICER_TABS.map((s) => ({ id: s, label: t(`officer.tab${s.charAt(0).toUpperCase()}${s.slice(1)}`) }))}
      />
      <SearchBox value={search} onChange={setSearch} />
      <div className="mt-4 space-y-3">
        {loading ? (
          <PageSpinner />
        ) : error ? (
          <LoadError error={error} onRetry={reload} />
        ) : issues.length === 0 ? (
          <EmptyState icon={ClipboardList} title={t('officer.empty')} />
        ) : (
          <>
            {issues.map((issue) => (
              <StaffIssueRow key={issue.id} issue={issue} />
            ))}
            <Pagination pagination={data.pagination} onChange={(o) => setParams({ ...(status !== 'open' ? { status } : {}), ...(o ? { offset: String(o) } : {}) }, { replace: true })} />
          </>
        )}
      </div>
    </div>
  );
}

/** Filters the loaded page only (the backend lists have no text search). */
export function SearchBox({ value, onChange }) {
  const { t } = useLanguage();
  return (
    <div className="relative mt-4 max-w-md">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('staffCommon.searchPlaceholder')}
        aria-label={t('staffCommon.searchPage')}
        className="block h-10 w-full rounded-lg border border-line bg-white pl-9 pr-3 text-sm focus:border-royal focus:outline-none focus:ring-2 focus:ring-royal/20"
      />
    </div>
  );
}
