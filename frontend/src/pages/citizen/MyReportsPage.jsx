/** GET /api/issues/mine with the backend's status filters and paging. */
import { useSearchParams } from 'react-router-dom';
import { FilePlus2, FileText } from 'lucide-react';
import Button from '../../components/ui/Button';
import { EmptyState, LoadError, Pagination } from '../../components/ui/primitives';
import { PageSpinner } from '../../components/ui/Spinner';
import ReportRow from './ReportRow';
import { issueApi } from '../../api/services';
import useAsync from '../../hooks/useAsync';
import { useLanguage } from '../../i18n/LanguageContext';

const PAGE_SIZE = 10;
const TABS = ['all', 'open', 'resolved', 'closed'];

export default function MyReportsPage() {
  const { t } = useLanguage();
  const [params, setParams] = useSearchParams();
  const status = TABS.includes(params.get('status')) ? params.get('status') : 'all';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const { data, loading, error, reload } = useAsync(() => issueApi.mine({ status, limit: PAGE_SIZE, offset }), [status, offset]);
  const tabLabel = { all: t('myReports.tabAll'), open: t('myReports.tabOpen'), resolved: t('myReports.tabResolved'), closed: t('myReports.tabClosed') };

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t('myReports.title')}</h1>
          <p className="mt-1 text-sm text-muted">{t('myReports.subtitle')}</p>
        </div>
        <Button to="/citizen/report" icon={FilePlus2}>
          {t('nav.report')}
        </Button>
      </div>

      <div className="mt-6 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={status === tab}
            onClick={() => setParams(tab === 'all' ? {} : { status: tab }, { replace: true })}
            className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium ${status === tab ? 'border-royal text-royal' : 'border-transparent text-muted hover:text-ink'}`}
          >
            {tabLabel[tab]}
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-3">
        {loading ? (
          <PageSpinner />
        ) : error ? (
          <LoadError error={error} onRetry={reload} />
        ) : data.issues.length === 0 ? (
          <EmptyState icon={FileText} title={t('myReports.empty')} action={<Button to="/citizen/report">{t('nav.report')}</Button>} />
        ) : (
          <>
            {data.issues.map((issue) => (
              <ReportRow key={issue.myReport.id} issue={issue} />
            ))}
            <Pagination
              pagination={data.pagination}
              onChange={(o) => setParams({ ...(status !== 'all' ? { status } : {}), ...(o ? { offset: String(o) } : {}) }, { replace: true })}
            />
          </>
        )}
      </div>
    </div>
  );
}
