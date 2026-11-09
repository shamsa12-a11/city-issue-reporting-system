/** Citizen home: own report counts, recent reports, latest notifications. */
import { Link } from 'react-router-dom';
import { Bell, CheckCircle2, CircleDot, FilePlus2, FileText, Lock } from 'lucide-react';
import Button from '../../components/ui/Button';
import { Card, EmptyState, LoadError, SectionHeading } from '../../components/ui/primitives';
import { PageSpinner, Spinner } from '../../components/ui/Spinner';
import ReportRow from './ReportRow';
import { issueApi, notificationApi } from '../../api/services';
import useAsync from '../../hooks/useAsync';
import { useAuth } from '../../auth/AuthContext';
import { useLanguage } from '../../i18n/LanguageContext';

async function loadCounts() {
  const count = (status) => issueApi.mine({ status, limit: 1 }).then((r) => r.pagination.total);
  const [all, open, resolved, closed] = await Promise.all([count('all'), count('open'), count('resolved'), count('closed')]);
  return { all, open, resolved, closed };
}

export default function DashboardPage() {
  const { t, formatDate, language } = useLanguage();
  const { user } = useAuth();
  const counts = useAsync(loadCounts, []);
  const recent = useAsync(() => issueApi.mine({ limit: 5 }), []);
  const notes = useAsync(() => notificationApi.list({ limit: 5 }), []);

  const stats = [
    { key: 'all', label: t('citizen.statTotal'), icon: FileText, cls: 'bg-royal-50 text-royal' },
    { key: 'open', label: t('citizen.statOpen'), icon: CircleDot, cls: 'bg-warning-50 text-amber-700' },
    { key: 'resolved', label: t('citizen.statResolved'), icon: CheckCircle2, cls: 'bg-success-50 text-success' },
    { key: 'closed', label: t('citizen.statClosed'), icon: Lock, cls: 'bg-slate-100 text-muted' },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t('citizen.welcome', { name: user.fullName.split(' ')[0] })}</h1>
          <p className="mt-1 text-sm text-muted">{t('citizen.welcomeText')}</p>
        </div>
        <Button to="/citizen/report" icon={FilePlus2}>
          {t('nav.report')}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map(({ key, label, icon: Icon, cls }) => (
          <Card key={key} className="p-5">
            <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${cls}`}>
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
            <p className="mt-4 text-2xl font-bold">{counts.loading ? <Spinner /> : counts.error ? '—' : counts.data[key]}</p>
            <p className="text-sm text-muted">{label}</p>
          </Card>
        ))}
      </div>

      <div className="grid gap-8 lg:grid-cols-5">
        <section className="lg:col-span-3">
          <SectionHeading
            title={t('citizen.recentReports')}
            action={
              <Link to="/citizen/reports" className="text-sm font-semibold text-royal hover:text-royal-700">
                {t('common.viewAll')}
              </Link>
            }
          />
          <div className="mt-4 space-y-3">
            {recent.loading ? (
              <PageSpinner />
            ) : recent.error ? (
              <LoadError error={recent.error} onRetry={recent.reload} />
            ) : recent.data.issues.length === 0 ? (
              <EmptyState icon={FileText} title={t('citizen.noReports')} action={<Button to="/citizen/report">{t('citizen.firstReport')}</Button>} />
            ) : (
              recent.data.issues.map((issue) => <ReportRow key={issue.myReport.id} issue={issue} />)
            )}
          </div>
        </section>

        <section className="lg:col-span-2">
          <SectionHeading
            title={t('citizen.latestNotifications')}
            action={
              <Link to="/citizen/notifications" className="text-sm font-semibold text-royal hover:text-royal-700">
                {t('common.viewAll')}
              </Link>
            }
          />
          <Card className="mt-4 divide-y divide-line">
            {notes.loading ? (
              <PageSpinner />
            ) : notes.error ? (
              <div className="p-4">
                <LoadError error={notes.error} onRetry={notes.reload} />
              </div>
            ) : notes.data.notifications.length === 0 ? (
              <p className="flex items-center gap-2 p-5 text-sm text-muted">
                <Bell className="h-4 w-4" aria-hidden="true" />
                {t('citizen.noNotifications')}
              </p>
            ) : (
              notes.data.notifications.map((n) => (
                <div key={n.id} className="flex gap-3 p-4">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.readAt ? 'bg-line' : 'bg-royal'}`} aria-hidden="true" />
                  <div className="min-w-0">
                    <p className={`text-sm ${n.readAt ? 'text-muted' : 'font-medium text-ink'}`}>{language === 'so' ? n.messageSo : n.messageEn}</p>
                    <p className="mt-1 text-xs text-muted">{formatDate(n.createdAt, true)}</p>
                  </div>
                </div>
              ))
            )}
          </Card>
        </section>
      </div>
    </div>
  );
}
