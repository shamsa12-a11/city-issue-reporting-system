/**
 * District performance report (Feature 13), computed live from the
 * database on every request.
 *
 * Population: issues RECEIVED (created_at) within [from, to] (inclusive
 * calendar dates, database time zone), optionally one category / district.
 * For each district and each month of the range:
 *   received                count of issues
 *   resolved                issues now resolved or closed
 *   averageResolutionHours  mean of resolved_at - created_at over resolved
 *                           issues (latest resolution), 1 decimal
 *   slaBreaches             SLA breached, the same rule as toSla()
 *                           (sla.js slaBreachedSql): open issues past the
 *                           deadline, resolved/closed ones resolved at or
 *                           after it
 *   slaBreachPercent        slaBreaches / received * 100, 1 decimal
 *   reopened                issues reopened at least once (reopen_count > 0)
 *   reopenedRate            reopened / issues ever resolved (from
 *                           status_history) * 100, 1 decimal
 * Districts and months without issues show zero values. Totals and the
 * monthly chart are sums of the same query rows (no sample data).
 *
 * Scope: admin = every district (optional districtId); supervisor = their
 * own district only. The report contains counts only: no issue, citizen or
 * staff details, so sensitive issues are counted like any other.
 *
 * One aggregate query (grouped by district and month) plus the district
 * list; no per-issue queries. Tables: issues, status_history, districts.
 * All SQL is parameterized.
 */
const db = require('../config/db');
const AppError = require('../utils/AppError');
const { slaBreachedSql } = require('./sla');

/** Default range: the current month and the 11 before it. Longest allowed range in months. */
const DEFAULT_MONTHS = 12;
const MAX_MONTHS = 60;

const round1 = (n) => Math.round(n * 10) / 10;

/** 'YYYY-MM' labels from the month of `from` to the month of `to`. */
function monthsBetween(from, to) {
  const months = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

const emptySums = () => ({ received: 0, resolved: 0, resolutionSeconds: 0, resolutionCount: 0, breaches: 0, reopened: 0, everResolved: 0 });

function addSums(target, row) {
  target.received += row.received;
  target.resolved += row.resolved;
  target.resolutionSeconds += Number(row.resolution_seconds_sum);
  target.resolutionCount += row.resolution_count;
  target.breaches += row.breaches;
  target.reopened += row.reopened;
  target.everResolved += row.ever_resolved;
  return target;
}

/** The metrics of a set of summed rows (zero values when empty). */
function toMetrics(s) {
  return {
    received: s.received,
    resolved: s.resolved,
    averageResolutionHours: s.resolutionCount === 0 ? 0 : round1(s.resolutionSeconds / s.resolutionCount / 3600),
    slaBreaches: s.breaches,
    slaBreachPercent: s.received === 0 ? 0 : round1((s.breaches / s.received) * 100),
    reopened: s.reopened,
    reopenedRate: s.everResolved === 0 ? 0 : round1((s.reopened / s.everResolved) * 100),
  };
}

/** Today's date and the time in the database (defaults use database time). */
async function databaseToday() {
  const {
    rows: [row],
  } = await db.query(`SELECT to_char(current_date, 'YYYY-MM-DD') AS report_today, now() AS report_generated_at`);
  return row;
}

function defaultFrom(to) {
  let [y, m] = to.slice(0, 7).split('-').map(Number);
  m -= DEFAULT_MONTHS - 1;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

/**
 * @param {object} input
 * @param {object} input.user        req.user (admin or supervisor)
 * @param {string} [input.from]      YYYY-MM-DD
 * @param {string} [input.to]        YYYY-MM-DD
 * @param {number} [input.categoryId]
 * @param {number} [input.districtId] admin only (supervisors: own district)
 * @throws {AppError} 400 RANGE_TOO_LONG / INVALID_RANGE
 */
async function getDistrictPerformance({ user, from = null, to = null, categoryId = null, districtId = null }) {
  const today = await databaseToday();
  const rangeTo = to ?? (from && from > today.report_today ? from : today.report_today);
  const rangeFrom = from ?? defaultFrom(rangeTo);
  if (rangeFrom > rangeTo) {
    throw new AppError(400, 'INVALID_RANGE', 'from must be on or before to');
  }
  const months = monthsBetween(rangeFrom, rangeTo);
  if (months.length > MAX_MONTHS) {
    throw new AppError(400, 'RANGE_TOO_LONG', `The date range can cover at most ${MAX_MONTHS} months`, { maxMonths: MAX_MONTHS });
  }

  let district = districtId;
  if (user.role === 'supervisor') {
    // Own district only; a supervisor without one gets an empty report (-1 matches nothing).
    district = user.district ? Number(user.district.id) : -1;
  }

  const { rows: districtRows } = await db.query(
    `SELECT d.id AS report_district_id, d.name, d.city, d.is_active
       FROM districts d
      WHERE ($1::int IS NULL OR d.id = $1::int)
      ORDER BY d.city, d.name, d.id`,
    [district]
  );
  const { rows } = await db.query(
    `WITH scoped AS (
       SELECT i.district_id,
              to_char(date_trunc('month', i.created_at), 'YYYY-MM') AS report_month,
              (i.status IN ('resolved', 'closed')) AS is_resolved,
              CASE WHEN i.status IN ('resolved', 'closed') AND i.resolved_at IS NOT NULL
                   THEN extract(epoch FROM (i.resolved_at - i.created_at)) END AS resolution_seconds,
              ${slaBreachedSql('i')} AS is_breached,
              (i.reopen_count > 0) AS is_reopened,
              EXISTS (SELECT 1 FROM status_history h
                       WHERE h.issue_id = i.id AND h.to_status = 'resolved') AS was_resolved
         FROM issues i
        WHERE i.created_at >= $1::date
          AND i.created_at < $2::date + 1
          AND ($3::int IS NULL OR i.category_id = $3::int)
          AND ($4::int IS NULL OR i.district_id = $4::int)
     )
     SELECT district_id, report_month,
            count(*)::int AS received,
            count(*) FILTER (WHERE is_resolved)::int AS resolved,
            coalesce(sum(resolution_seconds), 0)::float8 AS resolution_seconds_sum,
            count(resolution_seconds)::int AS resolution_count,
            count(*) FILTER (WHERE is_breached)::int AS breaches,
            count(*) FILTER (WHERE is_reopened)::int AS reopened,
            count(*) FILTER (WHERE was_resolved)::int AS ever_resolved
       FROM scoped
      GROUP BY district_id, report_month`,
    [rangeFrom, rangeTo, categoryId, district]
  );

  const byDistrict = new Map(); // district id -> Map(month -> sums)
  for (const row of rows) {
    const key = Number(row.district_id);
    if (!byDistrict.has(key)) byDistrict.set(key, new Map());
    byDistrict.get(key).set(row.report_month, addSums(emptySums(), row));
  }

  const overallByMonth = new Map(months.map((m) => [m, emptySums()]));
  const overall = emptySums();
  const districts = districtRows
    // Inactive districts are listed only when they have issues in the range.
    .filter((d) => d.is_active || byDistrict.has(Number(d.report_district_id)))
    .map((d) => {
      const perMonth = byDistrict.get(Number(d.report_district_id)) || new Map();
      const total = emptySums();
      const monthly = months.map((month) => {
        const sums = perMonth.get(month) || emptySums();
        for (const k of Object.keys(total)) {
          total[k] += sums[k];
          overallByMonth.get(month)[k] += sums[k];
          overall[k] += sums[k];
        }
        return { month, ...toMetrics(sums) };
      });
      return {
        district: { id: Number(d.report_district_id), name: d.name, city: d.city },
        metrics: toMetrics(total),
        monthly,
      };
    });

  return {
    filters: { from: rangeFrom, to: rangeTo, categoryId, districtId: district === -1 ? null : district },
    totals: toMetrics(overall),
    monthly: months.map((month) => ({ month, ...toMetrics(overallByMonth.get(month)) })),
    districts,
    generatedAt: today.report_generated_at,
  };
}

module.exports = { getDistrictPerformance, monthsBetween, DEFAULT_MONTHS, MAX_MONTHS };
