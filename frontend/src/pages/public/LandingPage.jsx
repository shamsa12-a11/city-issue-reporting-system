/**
 * Public landing page. Every number, map point and recent report comes from
 * the public API (no login); nothing is invented. Sensitive issues are never
 * returned by the API, so they are never shown or counted.
 */
import { ArrowRight, Camera, CheckCircle2, ClipboardCheck, EyeOff, Languages, MapPinned, Megaphone, Route, ShieldCheck, Wrench } from 'lucide-react';
import Button from '../../components/ui/Button';
import { Card, EmptyState, LoadError } from '../../components/ui/primitives';
import { PageSpinner, Spinner } from '../../components/ui/Spinner';
import CategoryIcon from '../../components/CategoryIcon';
import IssueCard from '../../components/IssueCard';
import { IssueMap, STATUS_COLORS } from '../../components/maps';
import { publicApi, referenceApi } from '../../api/services';
import useAsync from '../../hooks/useAsync';
import { useLanguage } from '../../i18n/LanguageContext';
import { useAuth } from '../../auth/AuthContext';

const OPEN = ['new', 'assigned', 'in_progress'];

/** Counts by status (pagination.total with limit=1) plus the heatmap summary. */
async function loadStats() {
  const count = (status) => publicApi.issues({ status, limit: 1 }).then((r) => r.pagination.total);
  const [newCount, assigned, inProgress, resolved, closed, heat] = await Promise.all([
    count('new'),
    count('assigned'),
    count('in_progress'),
    count('resolved'),
    count('closed'),
    publicApi.heatmap(),
  ]);
  return {
    total: heat.summary.issueCount,
    reports: heat.summary.totalWeight,
    open: newCount + assigned + inProgress,
    fixed: resolved + closed,
  };
}

function Hero() {
  const { t } = useLanguage();
  const { isAuthenticated, user } = useAuth();
  const reportTo = isAuthenticated && user.role === 'citizen' ? '/citizen/report' : isAuthenticated ? '/staff' : '/register';
  return (
    <section className="relative overflow-hidden bg-navy">
      <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'radial-gradient(#ffffff 1px, transparent 1px)', backgroundSize: '22px 22px' }} aria-hidden="true" />
      <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 py-16 sm:px-6 md:py-24 lg:grid-cols-2 lg:px-8">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-slate-200">
            <Megaphone className="h-3.5 w-3.5" aria-hidden="true" />
            {t('landing.heroBadge')}
          </p>
          <h1 className="mt-5 text-3xl font-bold leading-tight text-white sm:text-4xl lg:text-5xl">{t('landing.heroTitle')}</h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-slate-300">{t('landing.heroText')}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button to={reportTo} size="lg" icon={Camera}>
              {t('landing.ctaReport')}
            </Button>
            <Button to="/explore" size="lg" variant="outlineLight" icon={MapPinned}>
              {t('landing.ctaExplore')}
            </Button>
          </div>
        </div>
        <div className="hidden lg:block">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className="space-y-3">
              {[
                { icon: Camera, title: t('landing.step1Title'), text: t('landing.step1Text') },
                { icon: Route, title: t('landing.step2Title'), text: t('landing.step2Text') },
                { icon: Wrench, title: t('landing.step3Title'), text: t('landing.step3Text') },
                { icon: CheckCircle2, title: t('landing.step4Title'), text: t('landing.step4Text') },
              ].map(({ icon: Icon, title, text }, i) => (
                <div key={title} className="flex gap-4 rounded-xl bg-white p-4 shadow-sm">
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${i === 3 ? 'bg-success-50 text-success' : 'bg-royal-50 text-royal'}`}>
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-ink">{title}</p>
                    <p className="mt-0.5 text-sm text-muted">{text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Stats() {
  const { t } = useLanguage();
  const { data, loading, error } = useAsync(loadStats, []);
  const items = [
    { label: t('landing.statTotal'), value: data?.total, cls: 'text-navy' },
    { label: t('landing.statOpen'), value: data?.open, cls: 'text-amber-600' },
    { label: t('landing.statResolved'), value: data?.fixed, cls: 'text-success' },
    { label: t('landing.statReports'), value: data?.reports, cls: 'text-royal' },
  ];
  return (
    <section className="mx-auto -mt-10 max-w-7xl px-4 sm:px-6 lg:px-8" aria-labelledby="stats-title">
      <Card className="relative p-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="stats-title" className="text-base font-semibold">
            {t('landing.statsTitle')}
          </h2>
          <p className="text-xs text-muted">{t('landing.statsNote')}</p>
        </div>
        {error ? (
          <p className="mt-4 text-sm text-muted">{t('landing.statsUnavailable')}</p>
        ) : (
          <dl className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-4">
            {items.map((s) => (
              <div key={s.label} className="rounded-lg bg-page p-4">
                <dt className="text-xs font-medium text-muted">{s.label}</dt>
                <dd className={`mt-1 text-2xl font-bold ${s.cls}`}>{loading ? <Spinner className="h-5 w-5" /> : s.value.toLocaleString()}</dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
    </section>
  );
}

function HowItWorks() {
  const { t } = useLanguage();
  const steps = [
    { icon: Camera, title: t('landing.step1Title'), text: t('landing.step1Text') },
    { icon: Route, title: t('landing.step2Title'), text: t('landing.step2Text') },
    { icon: Wrench, title: t('landing.step3Title'), text: t('landing.step3Text') },
    { icon: ClipboardCheck, title: t('landing.step4Title'), text: t('landing.step4Text') },
  ];
  return (
    <section id="how-it-works" className="mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6 lg:px-8">
      <div className="max-w-2xl">
        <h2 className="text-2xl font-bold sm:text-3xl">{t('landing.howTitle')}</h2>
        <p className="mt-2 text-muted">{t('landing.howText')}</p>
      </div>
      <ol className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map(({ icon: Icon, title, text }, i) => (
          <li key={title} className="rounded-xl border border-line bg-white p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-navy text-white">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="text-sm font-semibold text-muted">0{i + 1}</span>
            </div>
            <p className="mt-4 font-semibold">{title}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">{text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Categories() {
  const { t, categoryName } = useLanguage();
  const { data, loading, error, reload } = useAsync(() => referenceApi.categories(), []);
  return (
    <section className="border-y border-line bg-white">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <h2 className="text-2xl font-bold sm:text-3xl">{t('landing.categoriesTitle')}</h2>
        {loading ? (
          <PageSpinner />
        ) : error ? (
          <div className="mt-6">
            <LoadError error={error} onRetry={reload} />
          </div>
        ) : (
          <ul className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {data.categories.map((c) => (
              <li key={c.id} className="flex flex-col items-center rounded-xl border border-line bg-page px-3 py-6 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-royal shadow-sm">
                  <CategoryIcon code={c.code} className="h-6 w-6" />
                </span>
                <span className="mt-3 text-sm font-semibold">{categoryName(c)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function MapAndRecent() {
  const { t } = useLanguage();
  const { data, loading, error, reload } = useAsync(() => publicApi.issues({ limit: 100 }), []);
  const issues = data?.issues || [];
  return (
    <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
      <div className="grid gap-10 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <h2 className="text-2xl font-bold sm:text-3xl">{t('landing.mapTitle')}</h2>
          <p className="mt-2 text-muted">{t('landing.mapText')}</p>
          <div className="mt-6 overflow-hidden rounded-xl border border-line bg-white p-2">
            {loading ? <PageSpinner /> : error ? <LoadError error={error} onRetry={reload} /> : <IssueMap issues={issues} className="h-[420px]" />}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted" aria-label="Legend">
            {Object.entries(STATUS_COLORS).map(([status, color]) => (
              <li key={status} className="inline-flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
                {t(`status.${status}`)}
              </li>
            ))}
          </ul>
        </div>
        <div className="lg:col-span-2">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-2xl font-bold sm:text-3xl">{t('landing.recentTitle')}</h2>
              <p className="mt-2 text-muted">{t('landing.recentText')}</p>
            </div>
          </div>
          <div className="mt-6 space-y-3">
            {loading ? (
              <PageSpinner />
            ) : error ? null : issues.length === 0 ? (
              <EmptyState icon={MapPinned} title={t('landing.noIssues')} />
            ) : (
              issues.slice(0, 4).map((issue) => <IssueCard key={issue.referenceNumber} issue={issue} />)
            )}
          </div>
          {issues.length > 0 && (
            <Button to="/explore" variant="secondary" className="mt-4 w-full">
              {t('common.viewAll')}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function Engage() {
  const { t } = useLanguage();
  const { isAuthenticated } = useAuth();
  return (
    <section className="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-8">
      <div className="flex flex-col items-start justify-between gap-6 rounded-2xl bg-royal px-6 py-10 sm:px-10 md:flex-row md:items-center">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-bold text-white sm:text-3xl">{t('landing.engageTitle')}</h2>
          <p className="mt-2 text-blue-100">{t('landing.engageText')}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          {!isAuthenticated && (
            <Button to="/register" variant="light" size="lg">
              {t('landing.engageCta')}
            </Button>
          )}
          <Button to="/explore" variant="outlineLight" size="lg">
            {t('landing.ctaExplore')}
          </Button>
        </div>
      </div>
    </section>
  );
}

function About() {
  const { t } = useLanguage();
  const points = [
    { icon: ShieldCheck, text: t('landing.aboutPoint1') },
    { icon: EyeOff, text: t('landing.aboutPoint2') },
    { icon: Languages, text: t('landing.aboutPoint3') },
  ];
  return (
    <section id="about" className="scroll-mt-20 border-t border-line bg-white">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:px-8">
        <div>
          <h2 className="text-2xl font-bold sm:text-3xl">{t('landing.aboutTitle')}</h2>
          <p className="mt-4 leading-relaxed text-muted">{t('landing.aboutText')}</p>
        </div>
        <ul className="space-y-4">
          {points.map(({ icon: Icon, text }) => (
            <li key={text} className="flex gap-4 rounded-xl border border-line bg-page p-5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-navy text-white">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <p className="pt-2 text-sm leading-relaxed text-ink">{text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export default function LandingPage() {
  return (
    <>
      <Hero />
      <Stats />
      <HowItWorks />
      <Categories />
      <MapAndRecent />
      <Engage />
      <About />
    </>
  );
}
