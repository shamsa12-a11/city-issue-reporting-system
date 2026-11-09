/**
 * Explore public issues (Feature 10): district, category and status filters,
 * sort by newest or most upvoted (Feature 11), list or map view. Filters live
 * in the URL so a filtered view can be shared.
 */
import { useSearchParams } from 'react-router-dom';
import { List, Map as MapIcon, SearchX } from 'lucide-react';
import { Card, EmptyState, LoadError, Pagination, SelectField } from '../../components/ui/primitives';
import { PageSpinner } from '../../components/ui/Spinner';
import IssueCard from '../../components/IssueCard';
import { IssueMap } from '../../components/maps';
import { publicApi, referenceApi } from '../../api/services';
import useAsync from '../../hooks/useAsync';
import { useLanguage } from '../../i18n/LanguageContext';

const PAGE_SIZE = 12;
const STATUSES = ['new', 'assigned', 'in_progress', 'resolved', 'closed'];

export default function ExplorePage() {
  const { t, categoryName } = useLanguage();
  const [params, setParams] = useSearchParams();
  const filters = {
    districtId: params.get('districtId') || '',
    categoryId: params.get('categoryId') || '',
    status: params.get('status') || '',
    sort: params.get('sort') || 'newest',
  };
  const view = params.get('view') === 'map' ? 'map' : 'list';
  const offset = Math.max(0, Number(params.get('offset')) || 0);

  const update = (changes) => {
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([k, v]) => (v === '' || v == null ? next.delete(k) : next.set(k, String(v))));
    if (!('offset' in changes)) next.delete('offset');
    setParams(next, { replace: true });
  };

  const reference = useAsync(() => Promise.all([referenceApi.categories(), referenceApi.districts()]), []);
  const key = JSON.stringify(filters);
  const list = useAsync(() => publicApi.issues({ ...filters, limit: PAGE_SIZE, offset }), [key, offset]);
  const mapData = useAsync(() => (view === 'map' ? publicApi.issues({ ...filters, limit: 100 }) : Promise.resolve(null)), [key, view]);

  const [categories, districts] = reference.data ? [reference.data[0].categories, reference.data[1].districts] : [[], []];

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">{t('explore.title')}</h1>
          <p className="mt-1 text-muted">{t('explore.subtitle')}</p>
        </div>
        <div className="inline-flex rounded-lg border border-line bg-white p-1" role="group" aria-label="View">
          {[
            { id: 'list', label: t('explore.list'), Icon: List },
            { id: 'map', label: t('explore.map'), Icon: MapIcon },
          ].map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              onClick={() => update({ view: id === 'list' ? '' : id, offset })}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${view === id ? 'bg-navy text-white' : 'text-muted hover:text-ink'}`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <Card className="mt-6 grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
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
        <SelectField label={t('common.status')} value={filters.status} onChange={(e) => update({ status: e.target.value })}>
          <option value="">{t('common.anyStatus')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('common.sort')} value={filters.sort} onChange={(e) => update({ sort: e.target.value === 'newest' ? '' : e.target.value })}>
          <option value="newest">{t('common.sortNewest')}</option>
          <option value="upvotes">{t('common.sortUpvotes')}</option>
        </SelectField>
      </Card>

      <div className="mt-6">
        {view === 'map' ? (
          mapData.loading ? (
            <PageSpinner />
          ) : mapData.error ? (
            <LoadError error={mapData.error} onRetry={mapData.reload} />
          ) : (
            <Card className="p-2">
              <IssueMap issues={mapData.data?.issues || []} className="h-[560px]" scrollWheelZoom />
              <p className="px-2 pb-1 pt-2 text-xs text-muted">{t('explore.resultsCount', { total: mapData.data?.pagination.total ?? 0 })}</p>
            </Card>
          )
        ) : list.loading ? (
          <PageSpinner />
        ) : list.error ? (
          <LoadError error={list.error} onRetry={list.reload} />
        ) : list.data.issues.length === 0 ? (
          <EmptyState icon={SearchX} title={t('explore.empty')} />
        ) : (
          <>
            <p className="mb-3 text-sm text-muted">{t('explore.resultsCount', { total: list.data.pagination.total })}</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {list.data.issues.map((issue) => (
                <IssueCard key={issue.referenceNumber} issue={issue} />
              ))}
            </div>
            <div className="mt-6">
              <Pagination pagination={list.data.pagination} onChange={(o) => update({ offset: o || '' })} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
