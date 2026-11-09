/**
 * Report an issue (Features 1 and 2).
 *   1. Category, description (10–2000), location (GPS or tap the map),
 *      optional district (only when it cannot be detected), 1–3 photos.
 *   2. Before sending, GET /api/issues/duplicates: if similar open reports
 *      exist (same category, 50 m, 7 days) the citizen chooses
 *      "Add my report to this issue" or "This is different".
 *   3. POST /api/issues (multipart). A 409 POSSIBLE_DUPLICATES (someone
 *      reported in between) shows the choice again.
 * The brief has no "title" field, so there is none here either.
 */
import { lazy, Suspense, useState } from 'react';
import { CheckCircle2, Crosshair, FilePlus2, GitMerge, MapPin, Plus, Users } from 'lucide-react';
import Button from '../../components/ui/Button';
import { Alert, Card, LoadError, Modal, SelectField, TextArea } from '../../components/ui/primitives';
import { PageSpinner } from '../../components/ui/Spinner';
import { StatusBadge } from '../../components/ui/badges';
import CategoryIcon from '../../components/CategoryIcon';
import { LocationPicker } from '../../components/maps';
import { Photo, PhotoPicker, validatePhotos } from '../../components/photos';
import { issueApi, referenceApi } from '../../api/services';
import useAsync from '../../hooks/useAsync';
import { useLanguage } from '../../i18n/LanguageContext';
import { charLength } from '../../utils/validation';
import { LIMITS } from '../../config';

// LOCAL DEV ONLY (Vite dev server + in-memory backend); not in production builds.
const DemoGpsPanel = import.meta.env.DEV ? lazy(() => import('../../dev/DemoGps')) : null;

const EMPTY = { categoryId: '', description: '', location: null, districtId: '', photos: [] };

function StepTitle({ n, children }) {
  return (
    <h2 className="flex items-center gap-3 text-base font-semibold">
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-navy text-xs font-bold text-white">{n}</span>
      {children}
    </h2>
  );
}

export default function ReportIssuePage() {
  const { t, errorMessage, categoryName, formatDate } = useLanguage();
  const reference = useAsync(() => Promise.all([referenceApi.categories(), referenceApi.districts()]), []);
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [phase, setPhase] = useState('form'); // form | checking | choose | submitting | done
  const [candidates, setCandidates] = useState([]);
  const [serverError, setServerError] = useState(null);
  const [gps, setGps] = useState({ state: 'idle' }); // idle | locating | error
  const [result, setResult] = useState(null);

  const set = (field, value) => {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setGps({ state: 'error', message: t('report.gpsUnavailable') });
      return;
    }
    setGps({ state: 'locating' });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        set('location', { latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        setGps({ state: 'idle' });
      },
      (err) => setGps({ state: 'error', message: err.code === 1 ? t('report.gpsDenied') : t('report.gpsUnavailable') }),
      // Always a fresh fix: a cached position from another spot would pin the wrong place.
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  };

  const validate = () => {
    const next = {};
    if (!form.categoryId) next.categoryId = t('validation.category');
    const len = charLength(form.description.trim());
    if (len < LIMITS.descriptionMin || len > LIMITS.descriptionMax) next.description = t('validation.descriptionLength');
    if (!form.location) next.location = t('validation.location');
    const photoErrors = validatePhotos(form.photos, t);
    if (photoErrors.length) next.photos = photoErrors.join(' ');
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const send = async (decision = {}) => {
    setPhase('submitting');
    setServerError(null);
    try {
      const res = await issueApi.create({
        categoryId: form.categoryId,
        description: form.description.trim(),
        latitude: Number(form.location.latitude.toFixed(6)),
        longitude: Number(form.location.longitude.toFixed(6)),
        districtId: form.districtId,
        photos: form.photos,
        ...decision,
      });
      setResult(res);
      setPhase('done');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      if (err.code === 'POSSIBLE_DUPLICATES' && err.details?.candidates?.length) {
        setCandidates(err.details.candidates);
        setPhase('choose');
        return;
      }
      setServerError(err);
      setPhase('form');
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setPhase('checking');
    setServerError(null);
    try {
      const { candidates: found } = await issueApi.duplicates({
        categoryId: form.categoryId,
        latitude: Number(form.location.latitude.toFixed(6)),
        longitude: Number(form.location.longitude.toFixed(6)),
      });
      if (found.length > 0) {
        setCandidates(found);
        setPhase('choose');
        return;
      }
      await send();
    } catch (err) {
      setServerError(err);
      setPhase('form');
    }
  };

  if (reference.loading) return <PageSpinner />;
  if (reference.error) return <LoadError error={reference.error} onRetry={reference.reload} />;
  const [{ categories }, { districts }] = reference.data;

  if (phase === 'done' && result) {
    const merged = result.outcome === 'merged';
    return (
      <Card className="mx-auto max-w-xl p-8 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success-50 text-success">
          {merged ? <GitMerge className="h-7 w-7" /> : <CheckCircle2 className="h-7 w-7" />}
        </span>
        <h1 className="mt-5 text-xl font-bold">{merged ? t('report.successMerged') : t('report.successCreated')}</h1>
        <p className="mt-2 text-sm text-muted">{t('report.successText')}</p>
        <div className="mt-6 rounded-xl bg-page p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{t('common.reference')}</p>
          <p className="mt-1 font-mono text-2xl font-bold text-navy">{result.issue.referenceNumber}</p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-sm text-muted">
            <StatusBadge status={result.issue.status} />
            <span>
              {categoryName(result.issue.category)} · {result.issue.district.name}
            </span>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Button to={`/citizen/reports/${result.issue.id}`}>{t('report.viewReport')}</Button>
          <Button
            variant="secondary"
            icon={Plus}
            onClick={() => {
              setForm(EMPTY);
              setResult(null);
              setPhase('form');
            }}
          >
            {t('report.reportAnother')}
          </Button>
        </div>
      </Card>
    );
  }

  const busy = phase === 'checking' || phase === 'submitting';
  return (
    <div>
      <h1 className="text-2xl font-bold">{t('report.title')}</h1>
      <p className="mt-1 text-sm text-muted">{t('report.subtitle')}</p>

      <form onSubmit={submit} noValidate className="mt-6 space-y-6">
        {serverError && <Alert tone="error">{errorMessage(serverError)}</Alert>}

        <Card className="space-y-5 p-6">
          <StepTitle n={1}>{t('report.stepDetails')}</StepTitle>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">{t('report.category')}</legend>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {categories.map((c) => {
                const selected = String(form.categoryId) === String(c.id);
                return (
                  <label
                    key={c.id}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm font-medium transition-colors ${
                      selected ? 'border-royal bg-royal-50 text-royal-700 ring-1 ring-royal' : 'border-line bg-white hover:bg-page'
                    }`}
                  >
                    <input type="radio" name="category" value={c.id} checked={selected} onChange={() => set('categoryId', c.id)} className="sr-only" />
                    <CategoryIcon code={c.code} />
                    {categoryName(c)}
                  </label>
                );
              })}
            </div>
            {errors.categoryId && <p className="mt-1.5 text-xs font-medium text-critical">{errors.categoryId}</p>}
          </fieldset>
          <TextArea
            label={t('report.description')}
            rows={5}
            maxLength={LIMITS.descriptionMax}
            placeholder={t('report.descriptionPlaceholder')}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            error={errors.description}
            hint={t('report.chars', { count: charLength(form.description) })}
          />
        </Card>

        <Card className="space-y-4 p-6">
          <StepTitle n={2}>{t('report.stepLocation')}</StepTitle>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" icon={Crosshair} onClick={useMyLocation} loading={gps.state === 'locating'}>
              {gps.state === 'locating' ? t('report.locating') : t('report.useGps')}
            </Button>
            <span className="text-sm text-muted">{t('report.tapMap')}</span>
          </div>
          {gps.state === 'error' && <Alert tone="warning">{gps.message}</Alert>}
          <div className={`overflow-hidden rounded-xl border ${errors.location ? 'border-critical' : 'border-line'}`}>
            <LocationPicker value={form.location} onChange={(loc) => set('location', loc)} className="h-80" />
          </div>
          {form.location ? (
            <p className="flex items-center gap-1.5 text-sm text-success">
              <MapPin className="h-4 w-4" aria-hidden="true" />
              {t('report.pinned', { lat: form.location.latitude.toFixed(5), lng: form.location.longitude.toFixed(5) })}
            </p>
          ) : (
            errors.location && <p className="text-xs font-medium text-critical">{errors.location}</p>
          )}
          {DemoGpsPanel && (
            <Suspense fallback={null}>
              <DemoGpsPanel value={form.location} onChange={(loc) => set('location', loc)} />
            </Suspense>
          )}
          <SelectField label={t('report.district')} optional value={form.districtId} onChange={(e) => set('districtId', e.target.value)} hint={t('report.districtHelp')}>
            <option value="">{t('report.districtAuto')}</option>
            {districts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}, {d.city}
              </option>
            ))}
          </SelectField>
        </Card>

        <Card className="space-y-4 p-6">
          <StepTitle n={3}>{t('report.stepPhotos')}</StepTitle>
          <PhotoPicker files={form.photos} onChange={(files) => set('photos', files)} error={errors.photos} />
        </Card>

        <div className="flex justify-end">
          <Button type="submit" size="lg" icon={FilePlus2} loading={busy}>
            {phase === 'checking' ? t('report.checking') : phase === 'submitting' ? t('report.submitting') : t('report.submit')}
          </Button>
        </div>
      </form>

      <Modal
        open={phase === 'choose'}
        wide
        title={t('report.duplicatesTitle')}
        onClose={() => setPhase('form')}
        footer={
          <Button variant="secondary" onClick={() => send({ confirmDifferent: true })}>
            {t('report.thisIsDifferent')}
          </Button>
        }
      >
        <p className="text-sm text-muted">{t('report.duplicatesText')}</p>
        <ul className="mt-4 space-y-3">
          {candidates.map((c) => (
            <li key={c.id} className="flex flex-col gap-4 rounded-xl border border-line p-4 sm:flex-row">
              <div className="grid w-full shrink-0 grid-cols-3 gap-2 sm:w-48 sm:grid-cols-2">
                {c.photos.slice(0, 2).map((p) => (
                  <Photo key={p.id} photo={p} alt={c.referenceNumber} className="aspect-square rounded-lg" />
                ))}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-navy">{c.referenceNumber}</span>
                  <StatusBadge status={c.status} />
                </div>
                <p className="mt-1 text-sm text-muted">
                  {categoryName(c.category)} · {formatDate(c.createdAt)}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted">
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('report.distance', { metres: Math.round(c.distanceMetres) })}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Users className="h-3.5 w-3.5" aria-hidden="true" />
                    {c.reportCount === 1 ? t('common.report1') : t('common.reports', { count: c.reportCount })}
                  </span>
                </p>
                {c.alreadyReportedByYou ? (
                  <p className="mt-3 text-sm font-medium text-success">{t('report.alreadyYours')}</p>
                ) : (
                  <Button size="sm" className="mt-3" icon={GitMerge} onClick={() => send({ duplicateOfIssueId: c.id })}>
                    {t('report.addToThis')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}
