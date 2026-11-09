/**
 * Supervisor: overview, department issues (assign / reassign), officer
 * workload, escalations (shared with admin) and the duplicate-review queue.
 * Data is limited to the supervisor's own department by the backend.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CircleDot, ClipboardList, CopyCheck, Hammer, UserCheck, UserCog, UsersRound } from 'lucide-react';
import Button from '../../components/ui/Button';
import { Alert, Card, EmptyState, LoadError, Pagination, SectionHeading } from '../../components/ui/primitives';
import { PageSpinner } from '../../components/ui/Spinner';
import StaffIssueRow, { matchesSearch } from '../../components/staff/StaffIssueRow';
import AssignModal from '../../components/staff/AssignModal';
import Tabs from '../../components/staff/Tabs';
import { SearchBox, StatCard } from './OfficerPages';
import { adminApi, supervisorApi } from '../../api/services';
import useAsync from '../../hooks/useAsync';
import { issuePathForRole, useAuth } from '../../auth/AuthContext';
import { useLanguage } from '../../i18n/LanguageContext';

async function loadSupervisorOverview() {
  const count = (fn, params) => fn({ ...params, limit: 1 }).then((r) => r.pagination.total);
  const [newCount, assigned, inProgress, escalations, review, workload, newest] = await Promise.all([
    count(supervisorApi.issues, { status: 'new' }),
    count(supervisorApi.issues, { status: 'assigned' }),
    count(supervisorApi.issues, { status: 'in_progress' }),
    count(supervisorApi.escalations, { state: 'pending' }),
    count(supervisorApi.reviewIssues, { status: 'open' }),
    supervisorApi.workload(),
    supervisorApi.issues({ status: 'new', limit: 5 }),
  ]);
  return { newCount, assigned, inProgress, escalations, review, workload, newest: newest.issues };
}

export function SupervisorDashboard() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const { data, loading, error, reload } = useAsync(loadSupervisorOverview, []);
  const [assigning, setAssigning] = useState(null);
  if (!user.department) {
    return <Alert tone="warning" title={t('supervisor.title')}>{t('supervisor.noDepartment')}</Alert>;
  }
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">{t('supervisor.title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('supervisor.subtitle', { department: user.department.name })}</p>
      </div>
      {error ? (
        <LoadError error={error} onRetry={reload} />
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <StatCard icon={CircleDot} label={t('supervisor.statNew')} value={data?.newCount} loading={loading} />
          <StatCard icon={UserCheck} label={t('supervisor.statAssigned')} value={data?.assigned} tone="navy" loading={loading} />
          <StatCard icon={Hammer} label={t('supervisor.statInProgress')} value={data?.inProgress} tone="amber" loading={loading} />
          <StatCard icon={AlertTriangle} label={t('supervisor.statEscalations')} value={data?.escalations} tone="red" loading={loading} />
          <StatCard icon={CopyCheck} label={t('supervisor.statReview')} value={data?.review} tone="slate" loading={loading} />
        </div>
      )}
      <div className="grid gap-8 lg:grid-cols-5">
        <section className="lg:col-span-3">
          <SectionHeading
            title={t('supervisor.tabNew')}
            action={
              <Link to="/supervisor/issues" className="text-sm font-semibold text-royal hover:text-royal-700">
                {t('common.viewAll')}
              </Link>
            }
          />
          <div className="mt-4 space-y-3">
            {loading ? (
              <PageSpinner />
            ) : error ? null : data.newest.length === 0 ? (
              <EmptyState icon={ClipboardList} title={t('supervisor.empty')} />
            ) : (
              data.newest.map((issue) => (
                <StaffIssueRow
                  key={issue.id}
                  issue={issue}
                  action={
                    <Button size="sm" icon={UserCog} onClick={() => setAssigning(issue)}>
                      {t('supervisor.assign')}
                    </Button>
                  }
                />
              ))
            )}
          </div>
        </section>
        <section className="lg:col-span-2">
          <SectionHeading
            title={t('supervisor.workloadTitle')}
            action={
              <Link to="/supervisor/workload" className="text-sm font-semibold text-royal hover:text-royal-700">
                {t('common.viewAll')}
              </Link>
            }
          />
          <div className="mt-4">{loading ? <PageSpinner /> : error ? null : <WorkloadTable officers={data.workload.officers} />}</div>
        </section>
      </div>
      {assigning && (
        <AssignModal
          issue={assigning}
          currentOfficerId={null}
          onClose={() => setAssigning(null)}
          onDone={() => {
            setAssigning(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

const SUPERVISOR_TABS = [
  { id: 'new', key: 'supervisor.tabNew' },
  { id: 'assigned', key: 'supervisor.tabAssigned' },
  { id: 'in_progress', key: 'supervisor.tabInProgress' },
  { id: 'open', key: 'supervisor.tabOpen' },
];

export function SupervisorIssuesPage() {
  const { t, categoryName } = useLanguage();
  const [params, setParams] = useSearchParams();
  const status = SUPERVISOR_TABS.some((x) => x.id === params.get('status')) ? params.get('status') : 'new';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const [search, setSearch] = useState('');
  const [assigning, setAssigning] = useState(null);
  const [flash, setFlash] = useState(false);
  const { data, loading, error, reload } = useAsync(() => supervisorApi.issues({ status, limit: 20, offset }), [status, offset]);
  const issues = (data?.issues || []).filter((i) => matchesSearch(i, search, categoryName));
  return (
    <div>
      <h1 className="text-2xl font-bold">{t('supervisor.issuesTitle')}</h1>
      <p className="mt-1 text-sm text-muted">{t('supervisor.issuesSubtitle')}</p>
      <Tabs value={status} onChange={(s) => setParams(s === 'new' ? {} : { status: s }, { replace: true })} tabs={SUPERVISOR_TABS.map((x) => ({ id: x.id, label: t(x.key) }))} />
      <SearchBox value={search} onChange={setSearch} />
      {flash && (
        <Alert tone="success" className="mt-4" title={t('assign.done')}>
          {null}
        </Alert>
      )}
      <div className="mt-4 space-y-3">
        {loading ? (
          <PageSpinner />
        ) : error ? (
          <LoadError error={error} onRetry={reload} />
        ) : issues.length === 0 ? (
          <EmptyState icon={ClipboardList} title={t('supervisor.empty')} />
        ) : (
          <>
            {issues.map((issue) => (
              <StaffIssueRow
                key={issue.id}
                issue={issue}
                action={
                  <Button size="sm" variant={issue.officer ? 'secondary' : 'primary'} icon={UserCog} onClick={() => setAssigning(issue)}>
                    {issue.officer ? t('supervisor.reassign') : t('supervisor.assign')}
                  </Button>
                }
              />
            ))}
            <Pagination pagination={data.pagination} onChange={(o) => setParams({ ...(status !== 'new' ? { status } : {}), ...(o ? { offset: String(o) } : {}) }, { replace: true })} />
          </>
        )}
      </div>
      {assigning && (
        <AssignModal
          issue={assigning}
          currentOfficerId={assigning.officer?.id ?? null}
          onClose={() => setAssigning(null)}
          onDone={() => {
            setAssigning(null);
            setFlash(true);
            reload();
          }}
        />
      )}
    </div>
  );
}

function WorkloadTable({ officers }) {
  const { t } = useLanguage();
  if (officers.length === 0) return <EmptyState icon={UsersRound} title={t('supervisor.noOfficers')} />;
  const max = Math.max(1, ...officers.map((o) => o.openAssignedCount));
  return (
    <Card className="divide-y divide-line">
      {officers.map((o) => (
        <div key={o.id} className="flex items-center gap-4 p-4">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {o.name}
              {o.isOnLeave && <span className="rounded-full bg-warning-50 px-2 py-0.5 text-xs font-medium text-amber-800">{t('supervisor.onLeave')}</span>}
              {!o.isActive && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-muted">{t('staffCommon.inactive')}</span>}
            </p>
            <div className="mt-2 h-2 rounded-full bg-page" aria-hidden="true">
              <div className="h-2 rounded-full bg-royal" style={{ width: `${(o.openAssignedCount / max) * 100}%` }} />
            </div>
          </div>
          <p className="w-20 text-right text-sm">
            <span className="text-lg font-bold">{o.openAssignedCount}</span> <span className="text-xs text-muted">{t('supervisor.openIssues')}</span>
          </p>
        </div>
      ))}
    </Card>
  );
}

export function WorkloadPage() {
  const { t } = useLanguage();
  const { data, loading, error, reload } = useAsync(() => supervisorApi.workload(), []);
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold">{t('supervisor.workloadTitle')}</h1>
      <p className="mt-1 text-sm text-muted">
        {t('supervisor.workloadSubtitle')} {data?.department && `· ${data.department.name}`}
      </p>
      <div className="mt-6">{loading ? <PageSpinner /> : error ? <LoadError error={error} onRetry={reload} /> : <WorkloadTable officers={data.officers} />}</div>
    </div>
  );
}

const STATES = ['pending', 'actioned', 'admin_alerted', 'all'];
const STATE_KEYS = { pending: 'escalations.statePending', actioned: 'escalations.stateActioned', admin_alerted: 'escalations.stateAdminAlerted', all: 'escalations.stateAll' };

/** GET /api/supervisor/escalations or /api/admin/escalations. */
export function EscalationsPage({ admin = false }) {
  const { t, formatDate } = useLanguage();
  const [params, setParams] = useSearchParams();
  const fallback = admin ? 'admin_alerted' : 'pending';
  const state = STATES.includes(params.get('state')) ? params.get('state') : fallback;
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const api = admin ? adminApi.escalations : supervisorApi.escalations;
  const { data, loading, error, reload } = useAsync(() => api({ state, limit: 20, offset }), [state, offset, admin]);
  return (
    <div>
      <h1 className="text-2xl font-bold">{t('escalations.title')}</h1>
      <p className="mt-1 text-sm text-muted">{admin ? t('escalations.adminSubtitle') : t('escalations.subtitle')}</p>
      <Tabs value={state} onChange={(s) => setParams(s === fallback ? {} : { state: s }, { replace: true })} tabs={STATES.map((s) => ({ id: s, label: t(STATE_KEYS[s]) }))} />
      <div className="mt-5 space-y-3">
        {loading ? (
          <PageSpinner />
        ) : error ? (
          <LoadError error={error} onRetry={reload} />
        ) : data.issues.length === 0 ? (
          <EmptyState icon={AlertTriangle} title={t('escalations.empty')} />
        ) : (
          <>
            {data.issues.map((issue) => {
              const e = issue.slaEscalation;
              return (
                <StaffIssueRow
                  key={issue.id}
                  issue={issue}
                  extra={
                    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                      <span className="text-muted">{issue.department ? issue.department.name : t('staffCommon.noDepartment')}</span>
                      {e.actionRequired && <span className="font-semibold text-critical">{t('escalations.dueBy', { date: formatDate(e.actionDueAt, true) })}</span>}
                      {e.resolvedBeforeDetection && <span className="text-muted">{t('escalations.resolvedBeforeDetection')}</span>}
                      {e.actionedAt && (
                        <span className={e.actionedOnTime ? 'text-success' : 'text-amber-700'}>
                          {t('issueStaff.actionedAt', { date: formatDate(e.actionedAt, true) })}
                          {!e.actionedOnTime && ` · ${t('issueStaff.actionedLate')}`}
                        </span>
                      )}
                      {e.adminAlertedAt && (
                        <span className="text-critical">
                          {t('issueStaff.adminAlerted', { date: formatDate(e.adminAlertedAt, true) })} ·{' '}
                          {e.adminAlertReason === 'no_supervisor' ? t('escalations.reasonNoSupervisor') : t('escalations.reasonNoAction')}
                          {e.adminAlertDelivered === false && ` · ${t('escalations.notDelivered')}`}
                        </span>
                      )}
                    </p>
                  }
                />
              );
            })}
            <Pagination pagination={data.pagination} onChange={(o) => setParams({ ...(state !== fallback ? { state } : {}), ...(o ? { offset: String(o) } : {}) }, { replace: true })} />
          </>
        )}
      </div>
    </div>
  );
}

/** GET /api/supervisor/review-issues (list only: the backend has no merge / clear action). */
export function ReviewPage() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') === 'all' ? 'all' : 'open';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const { data, loading, error, reload } = useAsync(() => supervisorApi.reviewIssues({ status, limit: 20, offset }), [status, offset]);
  return (
    <div>
      <h1 className="text-2xl font-bold">{t('review.title')}</h1>
      <p className="mt-1 text-sm text-muted">{t('review.subtitle')}</p>
      <Alert tone="info" className="mt-4">
        {t('review.note')}
      </Alert>
      <Tabs
        value={status}
        onChange={(s) => setParams(s === 'open' ? {} : { status: s }, { replace: true })}
        tabs={[
          { id: 'open', label: t('review.tabOpen') },
          { id: 'all', label: t('review.tabAll') },
        ]}
      />
      <div className="mt-5 space-y-3">
        {loading ? (
          <PageSpinner />
        ) : error ? (
          <LoadError error={error} onRetry={reload} />
        ) : data.issues.length === 0 ? (
          <EmptyState icon={CopyCheck} title={t('review.empty')} />
        ) : (
          <>
            {data.issues.map((issue) => (
              <StaffIssueRow
                key={issue.id}
                issue={issue}
                extra={
                  issue.similarIssue && (
                    <p className="mt-2 text-xs text-amber-800">
                      {t('review.near', { metres: issue.similarIssue.distanceMetres })}{' '}
                      <Link to={issuePathForRole(user.role, issue.similarIssue.id)} className="font-mono font-semibold text-royal">
                        {issue.similarIssue.referenceNumber}
                      </Link>
                    </p>
                  )
                }
              />
            ))}
            <Pagination pagination={data.pagination} onChange={(o) => setParams({ ...(status !== 'open' ? { status } : {}), ...(o ? { offset: String(o) } : {}) }, { replace: true })} />
          </>
        )}
      </div>
    </div>
  );
}
