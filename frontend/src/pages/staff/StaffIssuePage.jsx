/**
 * Issue workspace for staff (officer, supervisor, admin), with only the
 * actions the backend allows that role:
 *   officer (assigned)     start work, waiting for materials, resolve with
 *                          after photos taken at the location (GPS check)
 *   supervisor (department) start work, waiting for materials, assign /
 *                          reassign an officer, comment (escalation action)
 *   admin                  reroute to a department, sensitive on/off
 *   every staff role       comments, history, photos, reports, SLA
 * Endpoints: GET /issues/:id, GET /issues/:id/status, GET/POST /issues/:id/comments,
 * PATCH /issues/:id/status, POST /issues/:id/resolve, POST /issues/:id/assign,
 * POST /admin/issues/:id/reroute, PATCH /admin/issues/:id/sensitive.
 */
import { lazy, Suspense, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Crosshair,
  Eye,
  EyeOff,
  MessageSquare,
  PackageCheck,
  PackageX,
  Play,
  Route as RouteIcon,
  SearchX,
  Star,
  UserCog,
} from 'lucide-react';
import Button from '../../components/ui/Button';
import { Alert, Card, EmptyState, LoadError, Modal, SelectField, TextArea } from '../../components/ui/primitives';
import { PageSpinner } from '../../components/ui/Spinner';
import { SlaBadge, StatusBadge } from '../../components/ui/badges';
import CategoryIcon from '../../components/CategoryIcon';
import { BeforeAfter, PhotoGrid, PhotoPicker, validatePhotos } from '../../components/photos';
import { PointMap, STATUS_COLORS } from '../../components/maps';
import AssignModal from '../../components/staff/AssignModal';
import { adminApi, issueApi, staffIssueApi } from '../../api/services';
import useAsync from '../../hooks/useAsync';
import { homeForRole, issuePathForRole, useAuth } from '../../auth/AuthContext';
import { useLanguage } from '../../i18n/LanguageContext';
import { charLength } from '../../utils/validation';
import { LIMITS } from '../../config';

const OPEN = ['new', 'assigned', 'in_progress'];

// LOCAL DEV ONLY (Vite dev server + in-memory backend); not in production builds.
const DemoGpsPanel = import.meta.env.DEV ? lazy(() => import('../../dev/DemoGps')) : null;

async function loadIssue(id) {
  const [detail, status, comments] = await Promise.all([staffIssueApi.detail(id), issueApi.status(id), staffIssueApi.comments(id, { limit: 100 })]);
  return { issue: detail.issue, status: status.issue, history: status.history, assignmentEvents: status.assignmentEvents || [], comments: comments.comments };
}

export default function StaffIssuePage({ backTo }) {
  const { id } = useParams();
  const { t } = useLanguage();
  const { user } = useAuth();
  const { data, loading, error, reload } = useAsync(() => loadIssue(id), [id]);
  return (
    <div>
      <Link to={backTo || homeForRole(user.role)} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t('issueStaff.back')}
      </Link>
      <div className="mt-4">
        {loading && !data ? (
          <PageSpinner />
        ) : error ? (
          error.code === 'ISSUE_NOT_FOUND' || error.code === 'VALIDATION_ERROR' ? (
            <EmptyState icon={SearchX} title={t('errors.ISSUE_NOT_FOUND')} />
          ) : (
            <LoadError error={error} onRetry={reload} />
          )
        ) : (
          <IssueWorkspace data={data} reload={reload} />
        )}
      </div>
    </div>
  );
}

function IssueWorkspace({ data, reload }) {
  const { t, categoryName, formatDate } = useLanguage();
  const { user } = useAuth();
  const { issue, history, assignmentEvents, comments } = data;
  const assignment = issue.currentAssignment;
  const isAssignedOfficer = user.role === 'officer' && assignment?.officer?.id === user.id;
  const isDeptSupervisor = user.role === 'supervisor' && user.department && issue.department && Number(user.department.id) === issue.department.id;
  const canWork = isAssignedOfficer || user.role === 'supervisor';
  const [flash, setFlash] = useState(null);
  const done = async (key) => {
    setFlash(key);
    await reload();
  };

  // Below 1280px (one column) the column wrappers use `display: contents`, so
  // the groups are ordered directly: header, then assignment and actions, then
  // the rest. From 1280px the two columns are unchanged.
  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <div className="contents xl:col-span-2 xl:block xl:space-y-6">
        <div className="order-1 space-y-6">
          {flash && (
            <Alert tone="success" title={t(flash)}>
              {null}
            </Alert>
          )}
          <Card className="p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-start gap-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-royal-50 text-royal">
                  <CategoryIcon code={issue.category.code} className="h-6 w-6" />
                </span>
                <div>
                  <p className="font-mono text-sm font-semibold text-navy">{issue.referenceNumber}</p>
                  <h1 className="mt-0.5 text-xl font-bold">{categoryName(issue.category)}</h1>
                  <p className="text-sm text-muted">
                    {issue.district.name}, {issue.district.city} · {issue.department ? issue.department.name : t('staffCommon.noDepartment')}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {issue.isSensitive && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-muted">
                    <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('staffCommon.sensitive')}
                  </span>
                )}
                <StatusBadge status={issue.status} subStatus={issue.subStatus} />
              </div>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-5 text-sm">
              <SlaBadge sla={issue.sla} />
              <span className="text-xs text-muted">{t('issue.dueAt', { date: formatDate(issue.sla.dueAt, true) })}</span>
              <span className="text-xs text-muted">{t('common.reportedOn', { date: formatDate(issue.createdAt, true) })}</span>
              {issue.reopenCount > 0 && <span className="text-xs font-semibold text-critical">{t('issueStaff.reopenCount', { n: issue.reopenCount })}</span>}
            </div>
            <div className="mt-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t('issueStaff.description')}</p>
              <p className="mt-1.5 whitespace-pre-line text-sm text-ink">{issue.description}</p>
            </div>
            {issue.supervisorReview.needed && issue.supervisorReview.similarIssue && (
              <Alert tone="warning" className="mt-5">
                {t('issueStaff.reviewFlag', { ref: issue.supervisorReview.similarIssue.referenceNumber })}{' '}
                <Link to={issuePathForRole(user.role, issue.supervisorReview.similarIssue.id)} className="font-semibold underline">
                  {t('staffCommon.seeIssue')}
                </Link>
              </Alert>
            )}
          </Card>

          {issue.slaEscalation && <EscalationCard escalation={issue.slaEscalation} />}
        </div>

        <div className="order-3 space-y-6">
          <Card className="p-6">
            <h2 className="text-base font-semibold">{t('publicIssue.photosTitle')}</h2>
            <div className="mt-4">
              <BeforeAfter before={issue.photos.before} after={issue.photos.after.filter((p) => p.isLatestResolution)} />
            </div>
            {issue.photos.reopen.length > 0 && (
              <div className="mt-6">
                <p className="mb-2 text-sm font-semibold">{t('issue.reopened')}</p>
                <PhotoGrid photos={issue.photos.reopen} alt={t('issue.reopened')} />
              </div>
            )}
          </Card>

          <Card className="p-6">
            <h2 className="text-base font-semibold">{t('issueStaff.reports')}</h2>
            <p className="mt-1 text-xs text-muted">{t('issueStaff.reportsNote')}</p>
            <ul className="mt-4 space-y-3">
              {issue.reports.map((r) => (
                <li key={r.id} className="rounded-lg bg-page p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                    {r.isOriginal ? t('issueStaff.originalReport') : t('issueStaff.mergedReport')} · {formatDate(r.createdAt, true)}
                  </p>
                  <p className="mt-1 whitespace-pre-line text-sm">{r.description}</p>
                </li>
              ))}
            </ul>
          </Card>

          <Comments issue={issue} comments={comments} history={history} onAdded={done} />

          <Card className="p-6">
            <h2 className="text-base font-semibold">{t('issue.history')}</h2>
            <StaffHistory entries={history} assignmentEvents={assignmentEvents} />
          </Card>
        </div>
      </div>

      <div className="contents xl:block xl:space-y-6">
        <div className="order-2 space-y-6">
          <Card className="p-6">
            <h2 className="text-base font-semibold">{t('issueStaff.assignment')}</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted">{t('issueStaff.assignedOfficer')}</dt>
                <dd className="text-right font-medium">{assignment?.officer ? assignment.officer.name : t('staffCommon.unassignedOfficer')}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">{t('issueStaff.supervisor')}</dt>
                <dd className="text-right font-medium">{assignment?.supervisor ? assignment.supervisor.name : '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">{t('staffCommon.reports')}</dt>
                <dd className="font-medium">{issue.reportCount}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">{t('issueStaff.rating')}</dt>
                <dd className="inline-flex items-center gap-1 font-medium">
                  {issue.fixRating.count > 0 ? (
                    <>
                      <Star className="h-4 w-4 fill-warning text-warning" aria-hidden="true" />
                      {t('issueStaff.ratingValue', { avg: issue.fixRating.average, count: issue.fixRating.count })}
                    </>
                  ) : (
                    t('issueStaff.noRating')
                  )}
                </dd>
              </div>
            </dl>
            {isDeptSupervisor && OPEN.includes(issue.status) && <AssignAction issue={issue} assignment={assignment} onDone={done} />}
          </Card>

          <WorkActions issue={issue} canWork={canWork} isAssignedOfficer={isAssignedOfficer} onDone={done} />
          {user.role === 'admin' && <AdminActions issue={issue} onDone={done} />}
        </div>

        <Card className="order-4 p-2">
          <p className="px-3 pb-2 pt-2 text-sm font-semibold">{t('publicIssue.location')}</p>
          <PointMap latitude={issue.location.latitude} longitude={issue.location.longitude} color={STATUS_COLORS[issue.status]} className="h-64" />
        </Card>
      </div>
    </div>
  );
}

function EscalationCard({ escalation }) {
  const { t, formatDate } = useLanguage();
  // Marked after the issue was already resolved/closed: nobody was asked to
  // act, so no deadline is shown (neutral card instead of red).
  const markerOnly = escalation.resolvedBeforeDetection === true;
  return (
    <Card className={`${markerOnly ? '' : 'border-critical/30 '}p-6`}>
      <h2 className={`flex items-center gap-2 text-base font-semibold ${markerOnly ? 'text-muted' : 'text-critical'}`}>
        <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        {t('issueStaff.escalation')}
      </h2>
      <ul className="mt-3 space-y-1.5 text-sm">
        <li>{t('issueStaff.escalatedAt', { date: formatDate(escalation.escalatedAt, true) })}</li>
        {markerOnly ? (
          <li className="text-muted">{t('issueStaff.resolvedBeforeDetection')}</li>
        ) : (
          escalation.supervisorsNotified && (
            <li className={escalation.actionRequired ? 'font-semibold text-critical' : undefined}>{t('issueStaff.actionDue', { date: formatDate(escalation.actionDueAt, true) })}</li>
          )
        )}
        {escalation.actionRequired && <li className="text-xs text-muted">{t('issueStaff.actionHint')}</li>}
        {escalation.actionedAt && (
          <li className={escalation.actionedOnTime ? 'text-success' : 'text-amber-700'}>
            {t('issueStaff.actionedAt', { date: formatDate(escalation.actionedAt, true) })}
            {!escalation.actionedOnTime && ` · ${t('issueStaff.actionedLate')}`}
          </li>
        )}
        {escalation.adminAlertedAt && (
          <li className="text-critical">
            {t('issueStaff.adminAlerted', { date: formatDate(escalation.adminAlertedAt, true) })} ·{' '}
            {escalation.adminAlertReason === 'no_supervisor' ? t('escalations.reasonNoSupervisor') : t('escalations.reasonNoAction')}
            {escalation.adminAlertDelivered === false && <span className="block text-xs">{t('issueStaff.noAdminDelivered')}</span>}
          </li>
        )}
      </ul>
    </Card>
  );
}

const actorLabel = (t, who) => (!who ? t('issue.system') : who.name ? `${who.name} (${t(`roles.${who.role}`)})` : t(`roles.${who.role}`));

/** Assignment row text: routing, officer assign, reassign, reroute, reopen escalation. */
function assignmentText(t, ev) {
  const department = ev.department?.name || t('staffCommon.noDepartment');
  const officer = ev.officer?.name || '—';
  const supervisor = ev.supervisor?.name || '—';
  switch (ev.type) {
    case 'auto_route':
      return t('issueStaff.evAutoRoute', { department });
    case 'officer_assign':
      return t('issueStaff.evOfficerAssign', { officer });
    case 'reassign':
      return t('issueStaff.evReassign', { officer });
    case 'manual_reroute':
      return t('issueStaff.evReroute', { department });
    case 'reopen_escalation':
      return t('issueStaff.evReopenEscalation', { supervisor });
    default:
      return ev.type;
  }
}

/**
 * Status changes (status_history) and assignment events (assignments) in one
 * timeline, oldest first. At the same time, the status change comes first
 * (e.g. New -> Assigned, then "Officer assigned").
 */
function StaffHistory({ entries, assignmentEvents = [] }) {
  const { t, formatDate } = useLanguage();
  const timeline = [
    ...entries.map((e, i) => ({ kind: 'status', key: `s${e.id}`, at: new Date(e.createdAt).getTime(), order: i, e })),
    ...assignmentEvents.map((ev, i) => ({ kind: 'assignment', key: `a${ev.id}`, at: new Date(ev.createdAt).getTime(), order: entries.length + i, ev })),
  ].sort((a, b) => a.at - b.at || a.order - b.order);
  if (!timeline.length) return <p className="mt-3 text-sm text-muted">{t('issue.noHistory')}</p>;
  return (
    <ol className="relative mt-5 space-y-6 border-l-2 border-line pl-6">
      {timeline.map((item) =>
        item.kind === 'assignment' ? (
          <li key={item.key} className="relative">
            <span className="absolute -left-[31px] top-1 h-3.5 w-3.5 rounded-full bg-white ring-4 ring-white" style={{ border: '3px solid #64748B' }} aria-hidden="true" />
            <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
              <UserCog className="h-4 w-4 text-muted" aria-hidden="true" />
              {assignmentText(t, item.ev)}
            </p>
            {item.ev.reason && <p className="mt-1 text-sm text-ink">{t('issueStaff.evReason', { reason: item.ev.reason })}</p>}
            <p className="mt-1 text-xs text-muted">
              {formatDate(item.ev.createdAt, true)} · {t('issue.by', { who: actorLabel(t, item.ev.assignedBy) })}
            </p>
          </li>
        ) : (
          <StatusHistoryItem key={item.key} e={item.e} />
        )
      )}
    </ol>
  );
}

function StatusHistoryItem({ e }) {
  const { t, formatDate } = useLanguage();
  return (
        <li className="relative">
          <span className="absolute -left-[31px] top-1 h-3.5 w-3.5 rounded-full ring-4 ring-white" style={{ backgroundColor: STATUS_COLORS[e.toStatus] || '#64748B' }} aria-hidden="true" />
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={e.toStatus} subStatus={e.toSubStatus} />
            {e.isReopen && <span className="text-xs font-semibold text-critical">{t('issue.reopened')}</span>}
          </div>
          {e.comment && <p className="mt-1.5 text-sm text-ink">{e.comment}</p>}
          <p className="mt-1 text-xs text-muted">
            {formatDate(e.createdAt, true)} · {t('issue.by', { who: actorLabel(t, e.changedBy) })}
          </p>
        </li>
  );
}

/** Comment box used by status actions (5–1000 characters). */
function useComment() {
  const { t } = useLanguage();
  const [comment, setComment] = useState('');
  const [error, setError] = useState(null);
  const valid = () => {
    const len = charLength(comment.trim());
    const ok = len >= LIMITS.commentMin && len <= LIMITS.commentMax;
    setError(ok ? null : t('validation.commentLength'));
    return ok;
  };
  return { comment, setComment, error, valid, reset: () => setComment('') };
}

function WorkActions({ issue, canWork, isAssignedOfficer, onDone }) {
  const { t, errorMessage } = useLanguage();
  const c = useComment();
  const [busy, setBusy] = useState(null);
  const [serverError, setServerError] = useState(null);
  const canStart = canWork && issue.status === 'assigned';
  const canWait = canWork && issue.status === 'in_progress';
  const canResolve = isAssignedOfficer && issue.status === 'in_progress';
  if (!canStart && !canWait && !canResolve) {
    return canWork ? (
      <Card className="p-6 text-sm text-muted">{t('issueStaff.noActions')}</Card>
    ) : null;
  }

  const run = async (key, call) => {
    if (!c.valid()) return;
    setBusy(key);
    setServerError(null);
    try {
      await call(c.comment.trim());
      c.reset();
      await onDone('issueStaff.statusDone');
    } catch (err) {
      setServerError(err);
    } finally {
      setBusy(null);
    }
  };
  const waiting = issue.subStatus === 'waiting_for_materials';

  return (
    <>
      {(canStart || canWait) && (
        <Card className="p-6">
          <h2 className="text-base font-semibold">{t('issueStaff.actions')}</h2>
          <div className="mt-4 space-y-4">
            {serverError && <Alert tone="error">{errorMessage(serverError)}</Alert>}
            <TextArea label={t('staffCommon.comment')} rows={2} maxLength={LIMITS.commentMax} value={c.comment} onChange={(e) => c.setComment(e.target.value)} error={c.error} hint={t('staffCommon.commentHint')} />
            {canStart && (
              <div>
                <Button icon={Play} className="w-full" loading={busy === 'start'} onClick={() => run('start', (comment) => staffIssueApi.setStatus(issue.id, { status: 'in_progress', comment }))}>
                  {t('issueStaff.startWork')}
                </Button>
                <p className="mt-1.5 text-xs text-muted">{t('issueStaff.startWorkHint')}</p>
              </div>
            )}
            {canWait && (
              <div>
                <Button
                  variant="secondary"
                  icon={waiting ? PackageCheck : PackageX}
                  className="w-full"
                  loading={busy === 'wait'}
                  onClick={() => run('wait', (comment) => staffIssueApi.setSubStatus(issue.id, { subStatus: waiting ? null : 'waiting_for_materials', comment }))}
                >
                  {waiting ? t('issueStaff.waitingOff') : t('issueStaff.waitingOn')}
                </Button>
                <p className="mt-1.5 text-xs text-muted">{t('issueStaff.waitingHint')}</p>
              </div>
            )}
          </div>
        </Card>
      )}
      {canResolve && <ResolveForm issue={issue} onDone={onDone} />}
    </>
  );
}

function ResolveForm({ issue, onDone }) {
  const { t, errorMessage } = useLanguage();
  const c = useComment();
  const [photos, setPhotos] = useState([]);
  const [photoError, setPhotoError] = useState(null);
  const [position, setPosition] = useState(null);
  const [gps, setGps] = useState({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState(null);

  const locate = () => {
    if (!navigator.geolocation) return setGps({ state: 'error', message: t('report.gpsUnavailable') });
    setGps({ state: 'locating' });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPosition({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        setGps({ state: 'idle' });
      },
      (err) => setGps({ state: 'error', message: err.code === 1 ? t('report.gpsDenied') : t('report.gpsUnavailable') }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  };

  const submit = async (e) => {
    e.preventDefault();
    const commentOk = c.valid();
    const pErrors = validatePhotos(photos, t);
    setPhotoError(pErrors.length ? pErrors.join(' ') : null);
    if (!position) setGps({ state: 'error', message: t('issueStaff.locationNeeded') });
    if (!commentOk || pErrors.length || !position) return;
    setBusy(true);
    setServerError(null);
    try {
      await staffIssueApi.resolve(issue.id, {
        comment: c.comment.trim(),
        latitude: Number(position.latitude.toFixed(6)),
        longitude: Number(position.longitude.toFixed(6)),
        photos,
      });
      await onDone('issueStaff.resolveDone');
    } catch (err) {
      setServerError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-success/30 p-6">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />
        {t('issueStaff.resolveTitle')}
      </h2>
      <p className="mt-1 text-sm text-muted">{t('issueStaff.resolveHint')}</p>
      <form onSubmit={submit} noValidate className="mt-4 space-y-4">
        {serverError && (
          <Alert tone="error">
            {errorMessage(serverError)}
            {serverError.details?.distanceMetres != null && ` (${serverError.details.distanceMetres} m)`}
          </Alert>
        )}
        <TextArea label={t('issueStaff.resolveComment')} rows={3} maxLength={LIMITS.commentMax} value={c.comment} onChange={(e) => c.setComment(e.target.value)} error={c.error} />
        <div>
          <Button variant="secondary" icon={Crosshair} onClick={locate} loading={gps.state === 'locating'}>
            {t('issueStaff.getLocation')}
          </Button>
          {position && <p className="mt-1.5 text-xs text-success">{t('issueStaff.yourLocation', { lat: position.latitude.toFixed(5), lng: position.longitude.toFixed(5) })}</p>}
          {gps.state === 'error' && <p className="mt-1.5 text-xs font-medium text-critical">{gps.message}</p>}
        </div>
        {DemoGpsPanel && (
          <Suspense fallback={null}>
            <DemoGpsPanel
              value={position}
              target={issue.location}
              onChange={(p) => {
                setPosition(p);
                setGps({ state: 'idle' });
              }}
            />
          </Suspense>
        )}
        <PhotoPicker files={photos} onChange={setPhotos} error={photoError} />
        <Button type="submit" className="w-full" loading={busy}>
          {t('issueStaff.resolveButton')}
        </Button>
      </form>
    </Card>
  );
}

function AssignAction({ issue, assignment, onDone }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const current = assignment?.officer?.id ?? null;
  return (
    <>
      <Button variant="secondary" icon={UserCog} className="mt-5 w-full" onClick={() => setOpen(true)}>
        {current ? t('supervisor.reassign') : t('supervisor.assign')}
      </Button>
      {open && (
        <AssignModal
          issue={issue}
          currentOfficerId={current}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            onDone('assign.done');
          }}
        />
      )}
    </>
  );
}

function Comments({ issue, comments, history = [], onAdded }) {
  const { t, errorMessage, formatDate } = useLanguage();
  // Internal comments (issue_comments) and comments written with a status
  // change (status_history, by a person), oldest first. The status-change
  // comments are read-only here; they also stay in the status history.
  const items = [
    ...comments.map((cm, i) => ({ key: `c${cm.id}`, at: new Date(cm.createdAt).getTime(), order: i, cm })),
    ...history
      .filter((h) => h.comment && h.changedBy)
      .map((h, i) => ({ key: `h${h.id}`, at: new Date(h.createdAt).getTime(), order: comments.length + i, h })),
  ].sort((a, b) => a.at - b.at || a.order - b.order);
  const c = useComment();
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    const len = charLength(c.comment.trim());
    if (len < 1 || len > LIMITS.commentMax) return;
    setBusy(true);
    setServerError(null);
    try {
      const res = await staffIssueApi.addComment(issue.id, c.comment.trim());
      c.reset();
      await onAdded(res.escalationActioned ? 'issueStaff.commentCountsAsAction' : 'issueStaff.commentAdded');
    } catch (err) {
      setServerError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-6">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <MessageSquare className="h-5 w-5 text-muted" aria-hidden="true" />
        {t('issueStaff.comments')}
      </h2>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{t('issueStaff.noComments')}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {items.map(({ key, cm, h }) =>
            cm ? (
              <li key={key} className="rounded-lg bg-page p-4">
                <p className="text-xs text-muted">
                  <span className="font-semibold text-ink">{cm.author.name}</span> · {t(`roles.${cm.author.role}`)} · {formatDate(cm.createdAt, true)}
                </p>
                <p className="mt-1 whitespace-pre-line text-sm">{cm.body}</p>
              </li>
            ) : (
              <li key={key} className="rounded-lg border border-line p-4">
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span className="font-semibold text-ink">{h.changedBy.name || t(`roles.${h.changedBy.role}`)}</span> · {t(`roles.${h.changedBy.role}`)} · {formatDate(h.createdAt, true)}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  {t('issueStaff.statusComment')}
                  <StatusBadge status={h.toStatus} subStatus={h.toSubStatus} />
                </p>
                <p className="mt-1 whitespace-pre-line text-sm">{h.comment}</p>
              </li>
            )
          )}
        </ul>
      )}
      <form onSubmit={submit} noValidate className="mt-4 space-y-3">
        {serverError && <Alert tone="error">{errorMessage(serverError)}</Alert>}
        <TextArea label={t('issueStaff.addComment')} rows={2} maxLength={LIMITS.commentMax} placeholder={t('issueStaff.commentPlaceholder')} value={c.comment} onChange={(e) => c.setComment(e.target.value)} />
        <div className="flex justify-end">
          <Button type="submit" size="sm" loading={busy} disabled={!c.comment.trim()}>
            {t('issueStaff.addComment')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function AdminActions({ issue, onDone }) {
  const { t, errorMessage } = useLanguage();
  const [rerouteOpen, setRerouteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState(null);
  const toggleSensitive = async () => {
    setBusy(true);
    setServerError(null);
    try {
      await adminApi.setSensitive(issue.id, !issue.isSensitive);
      await onDone('staffCommon.saved');
    } catch (err) {
      setServerError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold">{t('issueStaff.adminTitle')}</h2>
      {serverError && (
        <Alert tone="error" className="mt-3">
          {errorMessage(serverError)}
        </Alert>
      )}
      <div className="mt-4 space-y-4">
        <div>
          <p className="text-sm font-medium">{t('issueStaff.sensitiveTitle')}</p>
          <p className="mt-0.5 text-sm text-muted">{issue.isSensitive ? t('issueStaff.sensitiveOn') : t('issueStaff.sensitiveOff')}</p>
          <Button variant="secondary" size="sm" className="mt-2" icon={issue.isSensitive ? Eye : EyeOff} loading={busy} onClick={toggleSensitive}>
            {issue.isSensitive ? t('issueStaff.markPublic') : t('issueStaff.markSensitive')}
          </Button>
        </div>
        {OPEN.includes(issue.status) && (
          <div>
            <Button variant="secondary" size="sm" icon={RouteIcon} onClick={() => setRerouteOpen(true)}>
              {t('issueStaff.rerouteTitle')}
            </Button>
          </div>
        )}
      </div>
      {rerouteOpen && (
        <RerouteModal
          issue={issue}
          onClose={() => setRerouteOpen(false)}
          onDone={() => {
            setRerouteOpen(false);
            onDone('issueStaff.rerouteDone');
          }}
        />
      )}
    </Card>
  );
}

/** POST /api/admin/issues/:id/reroute with an active department and a reason. Also used by the Unassigned queue. */
export function RerouteModal({ issue, onClose, onDone }) {
  const { t, errorMessage } = useLanguage();
  const departments = useAsync(() => adminApi.departments(), []);
  const [departmentId, setDepartmentId] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState(null);
  const submit = async () => {
    const next = {};
    if (!departmentId) next.department = t('unassigned.chooseDepartment');
    const len = charLength(reason.trim());
    if (len < 5 || len > 500) next.reason = t('staffCommon.reasonHint');
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setServerError(null);
    try {
      await adminApi.reroute(issue.id, { departmentId: Number(departmentId), reason: reason.trim() });
      onDone();
    } catch (err) {
      setServerError(err);
    } finally {
      setBusy(false);
    }
  };
  const active = (departments.data?.departments || []).filter((d) => d.isActive && (!issue.department || d.id !== issue.department.id));
  return (
    <Modal
      open
      title={t('unassigned.rerouteTitle', { ref: issue.referenceNumber })}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={busy}>
            {t('issueStaff.reroute')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {serverError && <Alert tone="error">{errorMessage(serverError)}</Alert>}
        <SelectField label={t('unassigned.department')} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} error={errors.department} disabled={departments.loading}>
          <option value="">{t('unassigned.chooseDepartment')}</option>
          {active.map((d) => (
            <option key={d.id} value={d.id}>
              {d.district.name} — {d.name}
            </option>
          ))}
        </SelectField>
        <TextArea label={t('staffCommon.reason')} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} hint={t('staffCommon.reasonHint')} />
      </div>
    </Modal>
  );
}
