/**
 * Status and SLA badges. Colours follow the palette: green = fixed,
 * amber = pending / due soon, red = overdue, blue = new / active.
 */
import { Clock, CircleCheck, CircleDot, Hammer, Lock, UserCheck } from 'lucide-react';
import { useLanguage } from '../../i18n/LanguageContext';

const STATUS_STYLE = {
  new: { cls: 'bg-royal-50 text-royal-700 ring-royal/20', Icon: CircleDot },
  assigned: { cls: 'bg-slate-100 text-navy ring-navy/15', Icon: UserCheck },
  in_progress: { cls: 'bg-warning-50 text-amber-800 ring-warning/30', Icon: Hammer },
  resolved: { cls: 'bg-success-50 text-success ring-success/25', Icon: CircleCheck },
  closed: { cls: 'bg-slate-100 text-muted ring-line', Icon: Lock },
};

export function StatusBadge({ status, subStatus }) {
  const { t } = useLanguage();
  const { cls, Icon } = STATUS_STYLE[status] || STATUS_STYLE.closed;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${cls}`}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {t(`status.${status}`)}
      </span>
      {subStatus && (
        <span className="inline-flex items-center rounded-full bg-warning-50 px-2 py-1 text-xs font-medium text-amber-800 ring-1 ring-inset ring-warning/30">
          {t(`status.${subStatus}`)}
        </span>
      )}
    </span>
  );
}

const SLA_STYLE = {
  on_track: 'bg-success-50 text-success ring-success/25',
  met: 'bg-success-50 text-success ring-success/25',
  warning: 'bg-warning-50 text-amber-800 ring-warning/30',
  breached: 'bg-critical-50 text-critical ring-critical/25',
};

/** "2d 4h" from seconds. */
export function useDuration() {
  const { t } = useLanguage();
  return (seconds) => {
    const s = Math.max(0, Math.floor(seconds || 0));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${t('sla.days', { n: d })} ${t('sla.hours', { n: h })}`;
    if (h > 0) return `${t('sla.hours', { n: h })} ${t('sla.minutes', { n: m })}`;
    return t('sla.minutes', { n: m });
  };
}

/** The backend `sla` object: { state, remainingSeconds, overdueSeconds, clockStopped }. */
export function SlaBadge({ sla, showTime = true }) {
  const { t } = useLanguage();
  const duration = useDuration();
  if (!sla) return null;
  let detail = null;
  if (showTime) {
    if (sla.state === 'breached') detail = t('sla.overdue', { time: duration(sla.overdueSeconds) });
    else if (!sla.clockStopped) detail = t('sla.remaining', { time: duration(sla.remainingSeconds) });
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${SLA_STYLE[sla.state]}`}>
      <Clock className="h-3.5 w-3.5" aria-hidden="true" />
      {t(`sla.${sla.state}`)}
      {detail && <span className="font-normal">· {detail}</span>}
    </span>
  );
}

const PAYMENT_STYLE = {
  pending: 'bg-warning-50 text-amber-800 ring-warning/30',
  confirmed: 'bg-success-50 text-success ring-success/25',
  failed: 'bg-critical-50 text-critical ring-critical/25',
  cancelled: 'bg-slate-100 text-muted ring-line',
};

export function PaymentStatusBadge({ status }) {
  const { t } = useLanguage();
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${PAYMENT_STYLE[status]}`}>
      {t(`payments.statusLabel.${status}`)}
    </span>
  );
}
