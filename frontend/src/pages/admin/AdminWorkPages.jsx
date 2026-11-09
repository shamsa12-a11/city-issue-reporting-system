/** Admin: overview, All issues (search, reroute), Unassigned queue (reroute) and payments (read-only). */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, CheckCircle2, CreditCard, Inbox, ListChecks, Route, Users } from 'lucide-react';
import Button from '../../components/ui/Button';
import { Alert, Card, EmptyState, LoadError, Modal, Pagination, SectionHeading, SelectField, TextField } from '../../components/ui/primitives';
import { PageSpinner } from '../../components/ui/Spinner';
import { PaymentStatusBadge } from '../../components/ui/badges';
import StaffIssueRow from '../../components/staff/StaffIssueRow';
import { StatCard } from '../staff/OfficerPages';
import { ChartCard } from '../staff/AnalyticsPage';
import { RerouteModal } from '../staff/StaffIssuePage';
import { adminApi, paymentApi, referenceApi } from '../../api/services';
import useAsync from '../../hooks/useAsync';
import { useLanguage } from '../../i18n/LanguageContext';

const C = { royal: '#2563EB', green: '#16A34A', red: '#DC2626', line: '#E2E8F0', muted: '#64748B' };
const axis = { fontSize: 12, fill: C.muted };

async function loadOverview() {
  const total = (p) => p.then((r) => r.pagination.total);
  const [report, unassigned, alerted, pending, users, routing] = await Promise.all([
    adminApi.report({}),
    total(adminApi.unassigned({ limit: 1 })),
    total(adminApi.escalations({ state: 'admin_alerted', limit: 1 })),
    total(adminApi.escalations({ state: 'pending', limit: 1 })),
    total(adminApi.users({ limit: 1 })),
    adminApi.routingRules(),
  ]);
  return { report, unassigned, alerted, pending, users, missing: routing.summary.missing };
}

export function AdminDashboard() {
  const { t } = useLanguage();
  const { data, loading, error, reload } = useAsync(loadOverview, []);
  if (loading) return <PageSpinner />;
  if (error) return <LoadError error={error} onRetry={reload} />;
  const { report } = data;
  const queues = [
    { to: '/admin/unassigned', icon: Inbox, label: t('adminHome.unassignedQueue'), value: data.unassigned, tone: data.unassigned ? 'amber' : 'green' },
    { to: '/admin/escalations', icon: AlertTriangle, label: t('adminHome.alertedEscalations'), value: data.alerted, tone: data.alerted ? 'red' : 'green' },
    { to: '/admin/escalations?state=pending', icon: AlertTriangle, label: t('adminHome.pendingEscalations'), value: data.pending, tone: 'amber' },
    { to: '/admin/routing', icon: Route, label: t('adminHome.routingMissing'), value: data.missing, tone: data.missing ? 'amber' : 'green' },
    { to: '/admin/users', icon: Users, label: t('adminHome.activeUsers'), value: data.users, tone: 'navy' },
  ];
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">{t('adminHome.title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('adminHome.subtitle')}</p>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {queues.map((q) => (
          <Link key={q.label} to={q.to} className="block rounded-xl transition-shadow hover:shadow-md">
            <StatCard icon={q.icon} label={q.label} value={q.value} tone={q.tone} />
          </Link>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={Inbox} label={t('analytics.kpiReceived')} value={report.totals.received} />
        <StatCard icon={CheckCircle2} label={t('analytics.kpiResolved')} value={report.totals.resolved} tone="green" />
        <StatCard icon={AlertTriangle} label={t('analytics.kpiBreachRate')} value={`${report.totals.slaBreachPercent}%`} tone="red" />
        <StatCard icon={CheckCircle2} label={t('analytics.kpiAvgHours')} value={t('analytics.hours', { n: report.totals.averageResolutionHours })} tone="navy" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title={t('analytics.trendTitle')}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={report.monthly} margin={{ top: 5, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid stroke={C.line} vertical={false} />
              <XAxis dataKey="month" tick={axis} tickLine={false} axisLine={{ stroke: C.line }} />
              <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="received" name={t('analytics.trendReceived')} fill={C.royal} radius={[4, 4, 0, 0]} />
              <Bar dataKey="resolved" name={t('analytics.trendResolved')} fill={C.green} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title={t('analytics.districtTitle')}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={report.districts.map((d) => ({ name: d.district.name, ...d.metrics }))} margin={{ top: 5, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid stroke={C.line} vertical={false} />
              <XAxis dataKey="name" tick={axis} tickLine={false} axisLine={{ stroke: C.line }} interval={0} angle={-20} textAnchor="end" height={50} />
              <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="received" name={t('analytics.trendReceived')} fill={C.royal} radius={[4, 4, 0, 0]} />
              <Bar dataKey="slaBreaches" name={t('analytics.trendBreaches')} fill={C.red} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
      <SectionHeading
        title={t('staffNav.analytics')}
        action={
          <Button to="/admin/analytics" variant="secondary" size="sm">
            {t('common.viewAll')}
          </Button>
        }
      />
    </div>
  );
}

const ISSUE_STATUSES = ['open', 'new', 'assigned', 'in_progress', 'resolved', 'closed'];

/**
 * GET /api/admin/issues: every issue with filters and a reference-number
 * search; open issues have a Reroute button (POST /admin/issues/:id/reroute,
 * reason required). Filters live in the URL, so Back keeps them.
 */
export function AllIssuesPage() {
  const { t, categoryName } = useLanguage();
  const [params, setParams] = useSearchParams();
  const filters = {
    status: params.get('status') || '',
    districtId: params.get('districtId') || '',
    categoryId: params.get('categoryId') || '',
    search: params.get('search') || '',
  };
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const [draftSearch, setDraftSearch] = useState(filters.search);
  const [rerouting, setRerouting] = useState(null);
  const [flash, setFlash] = useState(false);
  const reference = useAsync(() => Promise.all([referenceApi.categories(), referenceApi.districts()]), []);
  const categories = reference.data?.[0].categories || [];
  const districts = reference.data?.[1].districts || [];
  const key = JSON.stringify({ ...filters, offset });
  const { data, loading, error, reload } = useAsync(() => adminApi.issues({ ...filters, status: filters.status || 'all', limit: 20, offset }), [key]);
  const update = (changes) => {
    const next = new URLSearchParams(params);
    Object.entries({ ...changes, offset: changes.offset ?? '' }).forEach(([k, v]) => (v ? next.set(k, String(v)) : next.delete(k)));
    setParams(next, { replace: true });
  };
  return (
    <div>
      <h1 className="text-2xl font-bold">{t('allIssues.title')}</h1>
      <p className="mt-1 text-sm text-muted">{t('allIssues.subtitle')}</p>
      {flash && (
        <Alert tone="success" className="mt-4" title={t('issueStaff.rerouteDone')}>
          {null}
        </Alert>
      )}
      <Card
        as="form"
        className="mt-6 grid items-end gap-4 p-4 sm:grid-cols-2 lg:grid-cols-5"
        onSubmit={(e) => {
          e.preventDefault();
          update({ search: draftSearch.trim() });
        }}
      >
        <TextField label={t('allIssues.search')} placeholder={t('allIssues.searchPlaceholder')} value={draftSearch} maxLength={30} onChange={(e) => setDraftSearch(e.target.value)} />
        <SelectField label={t('common.status')} value={filters.status} onChange={(e) => update({ status: e.target.value })}>
          <option value="">{t('allIssues.anyStatus')}</option>
          {ISSUE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === 'open' ? t('allIssues.openOnly') : t(`status.${s}`)}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('common.district')} value={filters.districtId} onChange={(e) => update({ districtId: e.target.value })}>
          <option value="">{t('common.anyDistrict')}</option>
          {districts.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('common.category')} value={filters.categoryId} onChange={(e) => update({ categoryId: e.target.value })}>
          <option value="">{t('common.anyCategory')}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {categoryName(c)}
            </option>
          ))}
        </SelectField>
        <div className="flex gap-2">
          <Button type="submit" className="flex-1">
            {t('staffCommon.apply')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setDraftSearch('');
              setParams({}, { replace: true });
            }}
          >
            {t('staffCommon.reset')}
          </Button>
        </div>
      </Card>
      <div className="mt-6 space-y-3">
        {loading ? (
          <PageSpinner />
        ) : error ? (
          <LoadError error={error} onRetry={reload} />
        ) : data.issues.length === 0 ? (
          <EmptyState icon={ListChecks} title={t('allIssues.empty')} />
        ) : (
          <>
            {data.issues.map((issue) => (
              <StaffIssueRow
                key={issue.id}
                issue={issue}
                extra={<p className="mt-1 text-xs text-muted">{issue.department ? issue.department.name : t('staffCommon.noDepartment')}</p>}
                action={
                  issue.canReroute ? (
                    <Button size="sm" variant="secondary" icon={Route} onClick={() => setRerouting(issue)}>
                      {t('issueStaff.reroute')}
                    </Button>
                  ) : (
                    <span className="max-w-40 text-xs text-muted">{t('allIssues.notReroutable')}</span>
                  )
                }
              />
            ))}
            <Pagination pagination={data.pagination} onChange={(o) => update({ offset: o })} />
          </>
        )}
      </div>
      {rerouting && (
        <RerouteModal
          issue={rerouting}
          onClose={() => setRerouting(null)}
          onDone={() => {
            setRerouting(null);
            setFlash(true);
            reload();
          }}
        />
      )}
    </div>
  );
}

export function UnassignedPage() {
  const { t } = useLanguage();
  const [offset, setOffset] = useState(0);
  const [rerouting, setRerouting] = useState(null);
  const [flash, setFlash] = useState(false);
  const { data, loading, error, reload } = useAsync(() => adminApi.unassigned({ limit: 20, offset }), [offset]);
  return (
    <div>
      <h1 className="text-2xl font-bold">{t('unassigned.title')}</h1>
      <p className="mt-1 text-sm text-muted">{t('unassigned.subtitle')}</p>
      {flash && (
        <Alert tone="success" className="mt-4" title={t('issueStaff.rerouteDone')}>
          {null}
        </Alert>
      )}
      <div className="mt-6 space-y-3">
        {loading ? (
          <PageSpinner />
        ) : error ? (
          <LoadError error={error} onRetry={reload} />
        ) : data.issues.length === 0 ? (
          <EmptyState icon={Inbox} title={t('unassigned.empty')} />
        ) : (
          <>
            {data.issues.map((issue) => (
              <StaffIssueRow
                key={issue.id}
                issue={issue}
                action={
                  <Button size="sm" icon={Route} onClick={() => setRerouting(issue)}>
                    {t('issueStaff.reroute')}
                  </Button>
                }
              />
            ))}
            <Pagination pagination={data.pagination} onChange={setOffset} />
          </>
        )}
      </div>
      {rerouting && (
        <RerouteModal
          issue={{ ...rerouting, department: null }}
          onClose={() => setRerouting(null)}
          onDone={() => {
            setRerouting(null);
            setFlash(true);
            reload();
          }}
        />
      )}
    </div>
  );
}

export function AdminPaymentsPage() {
  const { t, formatDate } = useLanguage();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
  const provider = params.get('provider') || '';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const [viewing, setViewing] = useState(null);
  const { data, loading, error, reload } = useAsync(() => adminApi.payments({ status, provider, limit: 20, offset }), [status, provider, offset]);
  const update = (changes) => {
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    if (!('offset' in changes)) next.delete('offset');
    setParams(next, { replace: true });
  };
  return (
    <div>
      <h1 className="text-2xl font-bold">{t('paymentsAdmin.title')}</h1>
      <p className="mt-1 text-sm text-muted">{t('paymentsAdmin.subtitle')}</p>
      <Alert tone="warning" className="mt-4">
        {t('payments.simulatedBanner')}
      </Alert>
      <Card className="mt-5 grid gap-4 p-4 sm:grid-cols-2">
        <SelectField label={t('common.status')} value={status} onChange={(e) => update({ status: e.target.value })}>
          <option value="">{t('paymentsAdmin.anyStatus')}</option>
          {['pending', 'confirmed', 'failed', 'cancelled'].map((s) => (
            <option key={s} value={s}>
              {t(`payments.statusLabel.${s}`)}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('payments.provider')} value={provider} onChange={(e) => update({ provider: e.target.value })}>
          <option value="">{t('paymentsAdmin.anyProvider')}</option>
          <option value="evc_plus">EVC Plus</option>
          <option value="zaad">Zaad</option>
          <option value="edahab">eDahab</option>
        </SelectField>
      </Card>
      <div className="mt-5">
        {loading ? (
          <PageSpinner />
        ) : error ? (
          <LoadError error={error} onRetry={reload} />
        ) : data.payments.length === 0 ? (
          <EmptyState icon={CreditCard} title={t('payments.empty')} />
        ) : (
          <>
            <Card className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                    <th className="px-4 py-3 font-semibold">{t('payments.paymentReference')}</th>
                    <th className="px-4 py-3 font-semibold">{t('payments.provider')}</th>
                    <th className="px-4 py-3 font-semibold">{t('payments.purpose')}</th>
                    <th className="px-4 py-3 text-right font-semibold">{t('payments.amount')}</th>
                    <th className="px-4 py-3 font-semibold">{t('common.status')}</th>
                    <th className="px-4 py-3 font-semibold">{t('common.date')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.payments.map((p) => (
                    <tr key={p.reference} className="cursor-pointer hover:bg-page" onClick={() => setViewing(p.reference)}>
                      <td className="px-4 py-3 font-mono font-semibold text-navy">{p.reference}</td>
                      <td className="px-4 py-3">{p.provider.name}</td>
                      <td className="max-w-56 truncate px-4 py-3 text-muted">{p.purpose}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right font-semibold">
                        {p.amount} {p.currency}
                      </td>
                      <td className="px-4 py-3">
                        <PaymentStatusBadge status={p.status} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted">{formatDate(p.createdAt, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <div className="mt-4">
              <Pagination pagination={data.pagination} onChange={(o) => update({ offset: o ? String(o) : '' })} />
            </div>
          </>
        )}
      </div>
      {viewing && <PaymentDetailsModal reference={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

/** GET /api/payments/:reference (admins may read every payment and its receipt). */
function PaymentDetailsModal({ reference, onClose }) {
  const { t, formatDate } = useLanguage();
  const { data, loading, error, reload } = useAsync(() => paymentApi.get(reference), [reference]);
  const p = data?.payment;
  const r = data?.receipt;
  const rows = p
    ? [
        [t('common.status'), <PaymentStatusBadge key="s" status={p.status} />],
        [t('payments.provider'), p.provider.name],
        [t('payments.phone'), p.payerPhone],
        [t('payments.amount'), `${p.amount} ${p.currency}`],
        [t('payments.purpose'), p.purpose],
        ...(p.issue ? [[t('payments.linkIssue'), p.issue.referenceNumber]] : []),
        ...(r ? [[t('payments.receiptNumber'), r.receiptNumber], [t('payments.paidBy'), r.payer.name], [t('payments.transactionId'), r.transactionId], [t('payments.paidAt'), formatDate(r.confirmedAt, true)]] : []),
        ...(p.failureReason ? [[t('payments.failed'), p.failureReason]] : []),
      ]
    : [];
  return (
    <Modal open title={t('paymentsAdmin.detailsTitle', { ref: reference })} onClose={onClose}>
      {loading ? (
        <PageSpinner />
      ) : error ? (
        <LoadError error={error} onRetry={reload} />
      ) : (
        <dl className="divide-y divide-line text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 py-2.5">
              <dt className="text-muted">{label}</dt>
              <dd className="break-all text-right font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Modal>
  );
}
