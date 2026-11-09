/**
 * Maps & analytics (Features 12 and 13) for supervisors (own district,
 * enforced by the backend) and admins (all districts, optional district).
 *   heatmap      GET /supervisor|admin/heatmap
 *   charts/KPIs  GET /supervisor|admin/reports/district-performance
 *   by category  the same report filtered by each category (real aggregates)
 * Nothing here is computed from sample data.
 */
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, CheckCircle2, Clock, Inbox, Percent, RotateCcw } from 'lucide-react';
import Button from '../../components/ui/Button';
import { Card, LoadError, SelectField, TextField } from '../../components/ui/primitives';
import { PageSpinner } from '../../components/ui/Spinner';
import HeatmapView from '../../components/staff/HeatmapView';
import { StatCard } from './OfficerPages';
import { adminApi, referenceApi, supervisorApi } from '../../api/services';
import useAsync from '../../hooks/useAsync';
import { useLanguage } from '../../i18n/LanguageContext';

const C = { navy: '#142D4E', royal: '#2563EB', green: '#16A34A', amber: '#F59E0B', red: '#DC2626', line: '#E2E8F0', muted: '#64748B' };
const axis = { fontSize: 12, fill: C.muted };

export function ChartCard({ title, children, className = '' }) {
  return (
    <Card className={`p-5 ${className}`}>
      <h2 className="mb-4 text-sm font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

/** Report + heatmap (+ per-category totals) for the chosen filters. */
async function loadAnalytics(api, filters, categories) {
  const [report, heatmap, byCategory] = await Promise.all([
    api.report(filters),
    api.heatmap(filters),
    filters.categoryId ? Promise.resolve(null) : Promise.all(categories.map((c) => api.report({ ...filters, categoryId: c.id }).then((r) => ({ category: c, totals: r.totals })))),
  ]);
  return { report, heatmap, byCategory };
}

export default function AnalyticsPage({ admin = false }) {
  const { t, categoryName } = useLanguage();
  const api = admin ? adminApi : supervisorApi;
  const reference = useAsync(() => Promise.all([referenceApi.categories(), referenceApi.districts()]), []);
  const [draft, setDraft] = useState({ from: '', to: '', categoryId: '', districtId: '' });
  const [filters, setFilters] = useState({});
  const categories = reference.data?.[0].categories || [];
  const districts = reference.data?.[1].districts || [];
  const key = JSON.stringify(filters);
  const analytics = useAsync(() => (reference.data ? loadAnalytics(api, filters, categories) : new Promise(() => {})), [key, !!reference.data, admin]);

  const apply = (e) => {
    e.preventDefault();
    const next = {};
    for (const [k, v] of Object.entries(draft)) if (v && (admin || k !== 'districtId')) next[k] = v;
    setFilters(next);
  };

  const report = analytics.data?.report;
  const totals = report?.totals;
  const monthly = (report?.monthly || []).map((m) => ({ ...m, label: m.month }));
  const byDistrict = (report?.districts || []).map((d) => ({ name: d.district.name, ...d.metrics }));
  const byCategory = (analytics.data?.byCategory || []).map(({ category, totals: tt }) => ({ name: categoryName(category), ...tt }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('analytics.title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('analytics.subtitle')}</p>
      </div>

      <Card as="form" onSubmit={apply} className={`grid items-end gap-4 p-4 sm:grid-cols-2 ${admin ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
        <TextField label={t('staffCommon.from')} type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        <TextField label={t('staffCommon.to')} type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        <SelectField label={t('common.category')} value={draft.categoryId} onChange={(e) => setDraft({ ...draft, categoryId: e.target.value })}>
          <option value="">{t('common.anyCategory')}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {categoryName(c)}
            </option>
          ))}
        </SelectField>
        {admin && (
          <SelectField label={t('common.district')} value={draft.districtId} onChange={(e) => setDraft({ ...draft, districtId: e.target.value })}>
            <option value="">{t('common.anyDistrict')}</option>
            {districts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </SelectField>
        )}
        <div className="flex gap-2">
          <Button type="submit" className="flex-1">
            {t('staffCommon.apply')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setDraft({ from: '', to: '', categoryId: '', districtId: '' });
              setFilters({});
            }}
          >
            {t('staffCommon.reset')}
          </Button>
        </div>
      </Card>

      {reference.error ? (
        <LoadError error={reference.error} onRetry={reference.reload} />
      ) : analytics.loading ? (
        <PageSpinner />
      ) : analytics.error ? (
        <LoadError error={analytics.error} onRetry={analytics.reload} />
      ) : (
        <>
          <p className="text-xs text-muted">
            {t('staffCommon.period')}: {report.filters.from} → {report.filters.to}
          </p>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <StatCard icon={Inbox} label={t('analytics.kpiReceived')} value={totals.received} />
            <StatCard icon={CheckCircle2} label={t('analytics.kpiResolved')} value={totals.resolved} tone="green" />
            <StatCard icon={Clock} label={t('analytics.kpiAvgHours')} value={t('analytics.hours', { n: totals.averageResolutionHours })} tone="navy" />
            <StatCard icon={AlertTriangle} label={t('analytics.kpiBreaches')} value={totals.slaBreaches} tone="red" />
            <StatCard icon={Percent} label={t('analytics.kpiBreachRate')} value={`${totals.slaBreachPercent}%`} tone="amber" />
            <StatCard icon={RotateCcw} label={t('analytics.kpiReopenRate')} value={`${totals.reopenedRate}%`} tone="slate" />
          </div>

          <ChartCard title={t('analytics.heatmapTitle')}>
            <p className="-mt-2 mb-3 text-xs text-muted">
              {t('analytics.heatmapNote')} {t('analytics.issuesShown', { count: analytics.data.heatmap.summary.issueCount, weight: analytics.data.heatmap.summary.totalWeight })}
              {analytics.data.heatmap.summary.truncated && ` ${t('analytics.truncated')}`}
            </p>
            <HeatmapView heatmap={analytics.data.heatmap} />
          </ChartCard>

          {totals.received === 0 ? (
            <Card className="p-8 text-center text-sm text-muted">{t('analytics.noData')}</Card>
          ) : (
            <div className="grid gap-6 lg:grid-cols-2">
              <ChartCard title={t('analytics.trendTitle')} className="lg:col-span-2">
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={monthly} margin={{ top: 5, right: 16, left: -8, bottom: 0 }}>
                    <CartesianGrid stroke={C.line} vertical={false} />
                    <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={{ stroke: C.line }} />
                    <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line type="monotone" dataKey="received" name={t('analytics.trendReceived')} stroke={C.royal} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="resolved" name={t('analytics.trendResolved')} stroke={C.green} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="slaBreaches" name={t('analytics.trendBreaches')} stroke={C.red} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </ChartCard>
              <ChartCard title={t('analytics.districtTitle')}>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={byDistrict} margin={{ top: 5, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid stroke={C.line} vertical={false} />
                    <XAxis dataKey="name" tick={axis} tickLine={false} axisLine={{ stroke: C.line }} interval={0} angle={-20} textAnchor="end" height={50} />
                    <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="received" name={t('analytics.trendReceived')} fill={C.royal} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="resolved" name={t('analytics.trendResolved')} fill={C.green} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
              {byCategory.length > 0 ? (
                <ChartCard title={t('analytics.categoryTitle')}>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={byCategory} layout="vertical" margin={{ top: 5, right: 16, left: 24, bottom: 0 }}>
                      <CartesianGrid stroke={C.line} horizontal={false} />
                      <XAxis type="number" allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
                      <YAxis type="category" dataKey="name" tick={axis} tickLine={false} axisLine={false} width={110} />
                      <Tooltip />
                      <Bar dataKey="received" name={t('analytics.trendReceived')} fill={C.navy} radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
              ) : (
                <ChartCard title={t('analytics.slaTitle')}>
                  <SlaChart data={byDistrict} />
                </ChartCard>
              )}
              {byCategory.length > 0 && (
                <ChartCard title={t('analytics.slaTitle')} className="lg:col-span-2">
                  <SlaChart data={byDistrict} />
                </ChartCard>
              )}
            </div>
          )}

          <ChartCard title={t('analytics.tableTitle')}>
            <div className="-mx-5 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                    <th className="px-5 py-2 font-semibold">{t('analytics.colDistrict')}</th>
                    <th className="px-3 py-2 text-right font-semibold">{t('analytics.kpiReceived')}</th>
                    <th className="px-3 py-2 text-right font-semibold">{t('analytics.kpiResolved')}</th>
                    <th className="px-3 py-2 text-right font-semibold">{t('analytics.kpiAvgHours')}</th>
                    <th className="px-3 py-2 text-right font-semibold">{t('analytics.kpiBreaches')}</th>
                    <th className="px-3 py-2 text-right font-semibold">{t('analytics.kpiBreachRate')}</th>
                    <th className="px-5 py-2 text-right font-semibold">{t('analytics.kpiReopenRate')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {report.districts.map((d) => (
                    <tr key={d.district.id}>
                      <td className="px-5 py-2.5 font-medium">{d.district.name}</td>
                      <td className="px-3 py-2.5 text-right">{d.metrics.received}</td>
                      <td className="px-3 py-2.5 text-right">{d.metrics.resolved}</td>
                      <td className="px-3 py-2.5 text-right">{t('analytics.hours', { n: d.metrics.averageResolutionHours })}</td>
                      <td className="px-3 py-2.5 text-right">{d.metrics.slaBreaches}</td>
                      <td className={`px-3 py-2.5 text-right font-semibold ${d.metrics.slaBreachPercent > 0 ? 'text-critical' : 'text-success'}`}>{d.metrics.slaBreachPercent}%</td>
                      <td className="px-5 py-2.5 text-right">{d.metrics.reopenedRate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ChartCard>
        </>
      )}
    </div>
  );
}

function SlaChart({ data }) {
  const { t } = useLanguage();
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 5, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={C.line} vertical={false} />
        <XAxis dataKey="name" tick={axis} tickLine={false} axisLine={{ stroke: C.line }} interval={0} angle={-20} textAnchor="end" height={50} />
        <YAxis unit="%" tick={axis} tickLine={false} axisLine={false} domain={[0, 100]} />
        <Tooltip formatter={(v) => `${v}%`} />
        <Bar dataKey="slaBreachPercent" name={t('analytics.kpiBreachRate')} fill={C.amber} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
