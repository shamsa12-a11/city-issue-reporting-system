/**
 * Live issue heatmap (Feature 12): read from the issues table on every
 * request (no cache, no static image).
 *
 * Each point is an issue's real location weighted by its report_count
 * (original + merged reports). Filters: category, date range (report date,
 * inclusive, database time zone), district.
 *
 * Who sees what (sensitive issues):
 *   public      never sensitive issues (any district may be chosen)
 *   supervisor  their own district only; sensitive issues only of their own
 *               department
 *   admin       every issue, sensitive included
 *
 * With no matching issue: points [] and an empty-map message in both
 * languages. Points are capped at MAX_POINTS (truncated = true beyond it);
 * the summary always counts every match.
 *
 * Tables: issues. All SQL is parameterized.
 */
const db = require('../config/db');

const MAX_POINTS = 5000;

/** The Somali text is a first draft and should be checked by a native speaker. */
const EMPTY_MESSAGE = Object.freeze({
  en: 'No issues match the selected filters.',
  so: 'Ma jiraan arrimo u dhigma shaandhaynta aad dooratay.',
});

const WHERE = `
      WHERE ($1::boolean OR i.is_sensitive = FALSE OR ($2::int IS NOT NULL AND i.department_id = $2::int))
        AND ($3::int IS NULL OR i.district_id = $3::int)
        AND ($4::int IS NULL OR i.category_id = $4::int)
        AND ($5::date IS NULL OR i.created_at >= $5::date)
        AND ($6::date IS NULL OR i.created_at < $6::date + 1)`;

/**
 * @param {object} input
 * @param {object|null} input.user  req.user, or null for public users
 * @param {'public'|'supervisor'|'admin'} input.audience
 * @param {number} [input.categoryId]
 * @param {number} [input.districtId]  ignored for supervisors (own district)
 * @param {string} [input.from]        YYYY-MM-DD, inclusive
 * @param {string} [input.to]          YYYY-MM-DD, inclusive
 */
async function getHeatmap({ user = null, audience, categoryId = null, districtId = null, from = null, to = null }) {
  let includeSensitive = false;
  let ownDepartmentId = null;
  let district = districtId;
  if (audience === 'admin') includeSensitive = true;
  if (audience === 'supervisor') {
    ownDepartmentId = user.department ? Number(user.department.id) : null;
    // A supervisor without a district sees an empty map (district -1 matches nothing).
    district = user.district ? Number(user.district.id) : -1;
  }
  const filters = [includeSensitive, ownDepartmentId, district, categoryId, from, to];

  const {
    rows: [summary],
  } = await db.query(
    `SELECT count(*)::int AS heat_issue_count,
            coalesce(sum(i.report_count), 0)::int AS heat_total_weight,
            coalesce(max(i.report_count), 0)::int AS heat_max_weight,
            now() AS heat_generated_at
       FROM issues i${WHERE}`,
    filters
  );
  const { rows } = await db.query(
    `SELECT ST_Y(i.location::geometry) AS latitude, ST_X(i.location::geometry) AS longitude,
            i.report_count AS heat_weight
       FROM issues i${WHERE}
      ORDER BY i.id
      LIMIT $7`,
    [...filters, MAX_POINTS]
  );

  const issueCount = summary.heat_issue_count;
  return {
    filters: { categoryId, districtId: audience === 'supervisor' ? (district === -1 ? null : district) : districtId, from, to },
    points: rows.map((r) => ({ latitude: Number(r.latitude), longitude: Number(r.longitude), weight: r.heat_weight })),
    summary: {
      issueCount,
      totalWeight: summary.heat_total_weight,
      maxWeight: summary.heat_max_weight,
      truncated: issueCount > rows.length,
    },
    message: issueCount === 0 ? EMPTY_MESSAGE : null,
    generatedAt: summary.heat_generated_at,
  };
}

module.exports = { getHeatmap, MAX_POINTS, EMPTY_MESSAGE };
