/**
 * Feature 9: in-app notifications (GET /api/notifications, mark read,
 * mark all) and the citizen's own simulated SMS outbox (GET /notifications/sms).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, CheckCheck, MessageSquareText } from 'lucide-react';
import Button from '../../components/ui/Button';
import { Alert, Card, EmptyState, LoadError, Pagination } from '../../components/ui/primitives';
import { PageSpinner } from '../../components/ui/Spinner';
import { notificationApi } from '../../api/services';
import useAsync from '../../hooks/useAsync';
import { useLanguage } from '../../i18n/LanguageContext';
import { NOTIFICATIONS_CHANGED } from '../../layouts/WorkspaceLayout';
import { issuePathForRole, useAuth } from '../../auth/AuthContext';

const PAGE_SIZE = 20;
const changed = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));

function InApp() {
  const { t, formatDate, language, errorMessage } = useLanguage();
  const { user } = useAuth();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [actionError, setActionError] = useState(null);
  const { data, loading, error, reload, setData } = useAsync(() => notificationApi.list({ unread: unreadOnly ? 'true' : undefined, limit: PAGE_SIZE, offset }), [unreadOnly, offset]);

  const markRead = async (n) => {
    setActionError(null);
    try {
      const r = await notificationApi.markRead(n.id);
      setData((d) => ({ ...d, unreadCount: r.unreadCount, notifications: d.notifications.map((x) => (x.id === n.id ? { ...x, readAt: r.readAt } : x)) }));
      changed();
    } catch (err) {
      setActionError(err);
    }
  };
  const markAll = async () => {
    setActionError(null);
    try {
      await notificationApi.markAllRead();
      changed();
      reload();
    } catch (err) {
      setActionError(err);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => {
              setUnreadOnly(e.target.checked);
              setOffset(0);
            }}
            className="h-4 w-4 rounded border-line text-royal focus:ring-royal"
          />
          {t('notifications.unreadOnly')}
        </label>
        <Button variant="secondary" size="sm" icon={CheckCheck} onClick={markAll} disabled={!data || data.unreadCount === 0}>
          {t('notifications.markAll')}
        </Button>
      </div>
      {actionError && (
        <Alert tone="error" className="mt-3">
          {errorMessage(actionError)}
        </Alert>
      )}
      <div className="mt-4">
        {loading ? (
          <PageSpinner />
        ) : error ? (
          <LoadError error={error} onRetry={reload} />
        ) : data.notifications.length === 0 ? (
          <EmptyState icon={Bell} title={t('notifications.empty')} />
        ) : (
          <>
            <Card className="divide-y divide-line">
              {data.notifications.map((n) => (
                <div key={n.id} className={`flex flex-col gap-3 p-4 sm:flex-row sm:items-center ${n.readAt ? '' : 'bg-royal-50/40'}`}>
                  <span className={`hidden h-2.5 w-2.5 shrink-0 rounded-full sm:block ${n.readAt ? 'bg-line' : 'bg-royal'}`} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm ${n.readAt ? 'text-muted' : 'font-medium text-ink'}`}>{language === 'so' ? n.messageSo : n.messageEn}</p>
                    <p className="mt-1 text-xs text-muted">
                      {formatDate(n.createdAt, true)}
                      {n.issue && (
                        <>
                          {' · '}
                          <Link to={issuePathForRole(user.role, n.issue.id)} className="font-mono font-semibold text-royal">
                            {n.issue.referenceNumber}
                          </Link>
                        </>
                      )}
                    </p>
                  </div>
                  {!n.readAt && (
                    <Button variant="ghost" size="sm" onClick={() => markRead(n)}>
                      {t('notifications.markRead')}
                    </Button>
                  )}
                </div>
              ))}
            </Card>
            <div className="mt-4">
              <Pagination pagination={data.pagination} onChange={setOffset} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SmsOutbox() {
  const { t, formatDate } = useLanguage();
  const [offset, setOffset] = useState(0);
  const { data, loading, error, reload } = useAsync(() => notificationApi.sms({ limit: PAGE_SIZE, offset }), [offset]);
  return (
    <div>
      <Alert tone="info">{t('notifications.smsNote')}</Alert>
      <div className="mt-4">
        {loading ? (
          <PageSpinner />
        ) : error ? (
          <LoadError error={error} onRetry={reload} />
        ) : data.sms.length === 0 ? (
          <EmptyState icon={MessageSquareText} title={t('notifications.smsEmpty')} />
        ) : (
          <>
            <Card className="divide-y divide-line">
              {data.sms.map((m) => (
                <div key={m.id} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                    <span className="font-mono">{m.phoneNumber}</span>
                    <span>
                      {formatDate(m.createdAt, true)} · {m.language.toUpperCase()}
                    </span>
                  </div>
                  <p className="mt-2 rounded-lg bg-page px-3 py-2 text-sm text-ink">{m.message}</p>
                </div>
              ))}
            </Card>
            <div className="mt-4">
              <Pagination pagination={data.pagination} onChange={setOffset} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Shared by every role; the simulated SMS outbox only ever holds citizen messages. */
export default function NotificationsPage() {
  const { t } = useLanguage();
  const { user } = useAuth();
  if (user.role !== 'citizen') {
    return (
      <div>
        <h1 className="text-2xl font-bold">{t('notifications.title')}</h1>
        <div className="mt-6">
          <InApp />
        </div>
      </div>
    );
  }
  const [tab, setTab] = useState('inapp');
  return (
    <div>
      <h1 className="text-2xl font-bold">{t('notifications.title')}</h1>
      <p className="mt-1 text-sm text-muted">{t('notifications.subtitle')}</p>
      <div className="mb-5 mt-6 flex gap-1 border-b border-line" role="tablist">
        {[
          { id: 'inapp', label: t('notifications.tabInApp') },
          { id: 'sms', label: t('notifications.tabSms') },
        ].map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => setTab(x.id)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium ${tab === x.id ? 'border-royal text-royal' : 'border-transparent text-muted hover:text-ink'}`}
          >
            {x.label}
          </button>
        ))}
      </div>
      {tab === 'inapp' ? <InApp /> : <SmsOutbox />}
    </div>
  );
}
