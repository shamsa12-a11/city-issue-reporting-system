/**
 * Citizen issue reporting (Feature 1).
 *
 * createIssue() runs in two phases:
 *   1. resolveReportContext() — read-only checks: category is active and has
 *      an SLA, district from the GPS point (PostGIS), department from
 *      routing_rules. A rejected report never writes a photo to disk.
 *   2. persistNewIssue() — saves the photos, then writes every row in ONE
 *      transaction. If anything fails, the transaction rolls back and the
 *      saved photo files are deleted (withStoredPhotos).
 *
 * Step 5 (duplicate detection / merging) plugs in between the two phases:
 * it needs the resolved category and location, and either merges into an
 * existing issue or continues to persistNewIssue().
 * findDuplicateCandidates() (GET /api/issues/duplicates) is the read-only
 * candidate search; POST /api/issues does not use it yet.
 *
 * Tables: categories, slas, districts, routing_rules, departments, issues,
 * issue_reports, photos, status_history, issue_subscriptions.
 * All SQL is parameterized; all writes use the transaction client.
 */
const db = require('../config/db');
const AppError = require('../utils/AppError');
const { withStoredPhotos, getPhotoUrl, isValidStoragePath } = require('../storage/photoStorage');

/** Exact text required by the brief for reports outside every district. */
const OUTSIDE_SERVICE_AREA_MESSAGE = 'Outside service area';

/** Comment on the first status_history row (status_history.comment is required). */
const INITIAL_STATUS_COMMENT = 'Issue reported by citizen';

// GPS point as PostGIS geography. ST_MakePoint takes LONGITUDE first.
const pointSql = (lngParam, latParam) =>
  `ST_SetSRID(ST_MakePoint(${lngParam}::float8, ${latParam}::float8), 4326)::geography`;

// ---------------------------------------------------------------------------
// Phase 1: lookups (read-only, no transaction needed)
// ---------------------------------------------------------------------------

/**
 * Active category with its SLA.
 * @throws {AppError} 400 INVALID_CATEGORY, 422 CATEGORY_UNAVAILABLE (no SLA configured)
 */
async function findActiveCategoryWithSla(categoryId) {
  const { rows } = await db.query(
    `SELECT c.id, c.code, c.name_en, c.name_so, s.resolution_hours
       FROM categories c
       LEFT JOIN slas s ON s.category_id = c.id
      WHERE c.id = $1
        AND c.is_active = TRUE`,
    [categoryId]
  );
  const category = rows[0];
  if (!category) {
    throw new AppError(400, 'INVALID_CATEGORY', 'Please choose a valid issue category');
  }
  // issues.sla_due_at is NOT NULL, so an issue cannot be created without an SLA.
  if (category.resolution_hours == null) {
    console.error(`[issues] Category ${category.id} (${category.code}) has no SLA configured`);
    throw new AppError(
      422,
      'CATEGORY_UNAVAILABLE',
      'This category cannot accept reports right now. Please try again later.'
    );
  }
  return category;
}

/**
 * District whose boundary covers the point, or null.
 * ST_Covers includes points exactly on a boundary. Seed districts share edges,
 * so ORDER BY id makes the choice deterministic for such points.
 */
async function detectDistrict(longitude, latitude) {
  const { rows } = await db.query(
    `SELECT d.id, d.name, d.city
       FROM districts d
      WHERE d.is_active = TRUE
        AND d.boundary IS NOT NULL
        AND ST_Covers(d.boundary, ${pointSql('$1', '$2')})
      ORDER BY d.id
      LIMIT 1`,
    [longitude, latitude]
  );
  return rows[0] || null;
}

/** Active district by id, with whether it has a boundary loaded; or null. */
async function findActiveDistrict(districtId) {
  const { rows } = await db.query(
    `SELECT d.id, d.name, d.city, (d.boundary IS NOT NULL) AS has_boundary
       FROM districts d
      WHERE d.id = $1
        AND d.is_active = TRUE`,
    [districtId]
  );
  return rows[0] || null;
}

/**
 * Works out the issue's district.
 *  - Point inside a district boundary -> that district (any districtId sent is ignored).
 *  - Point inside no boundary:
 *      - districtId given, active, and it has NO boundary loaded -> that district
 *        (detection is not possible there, so the citizen's choice is accepted).
 *      - districtId unknown/inactive -> 400 INVALID_DISTRICT.
 *      - otherwise -> 422 OUTSIDE_SERVICE_AREA ("Outside service area").
 */
async function resolveDistrict({ longitude, latitude, districtId }) {
  const detected = await detectDistrict(longitude, latitude);
  if (detected) return detected;

  if (districtId != null) {
    const chosen = await findActiveDistrict(districtId);
    if (!chosen) {
      throw new AppError(400, 'INVALID_DISTRICT', 'Please choose a valid district');
    }
    if (!chosen.has_boundary) {
      return { id: chosen.id, name: chosen.name, city: chosen.city };
    }
  }
  throw new AppError(422, 'OUTSIDE_SERVICE_AREA', OUTSIDE_SERVICE_AREA_MESSAGE);
}

/**
 * Department from routing_rules for (category, district), if that department
 * is active. null = no rule -> the issue goes to the Admin Unassigned queue.
 */
async function findRoutedDepartment(categoryId, districtId) {
  const { rows } = await db.query(
    `SELECT dep.id, dep.name
       FROM routing_rules rr
       JOIN departments dep ON dep.id = rr.department_id
      WHERE rr.category_id = $1
        AND rr.district_id = $2
        AND dep.is_active = TRUE`,
    [categoryId, districtId]
  );
  return rows[0] || null;
}

/** Phase 1: everything needed to create the issue, or a client-facing error. */
async function resolveReportContext({ categoryId, latitude, longitude, districtId }) {
  const category = await findActiveCategoryWithSla(categoryId);
  const district = await resolveDistrict({ longitude, latitude, districtId });
  const department = await findRoutedDepartment(category.id, district.id);
  return { category, district, department };
}

// ---------------------------------------------------------------------------
// Phase 2: writes (one transaction)
// ---------------------------------------------------------------------------

/**
 * Saves the photos and writes issue, original report, before photos, first
 * status history row and the reporter's subscription in one transaction.
 * @returns {Promise<{ issue: object, photos: Array<{ id: number, storagePath: string }> }>}
 */
async function persistNewIssue({ citizenId, description, latitude, longitude, files }, context) {
  const { category, district, department } = context;

  return withStoredPhotos(files, (storedPhotos) =>
    db.withTransaction(async (client) => {
      // reference_number is generated by the database from the id.
      // sla_due_at uses database time, like created_at.
      const {
        rows: [issue],
      } = await client.query(
        `INSERT INTO issues
                (category_id, district_id, department_id, created_by, description,
                 location, sla_due_at)
         VALUES ($1, $2, $3, $4, $5,
                 ${pointSql('$6', '$7')},
                 now() + make_interval(hours => $8::int))
         RETURNING id, reference_number, status, report_count, created_at, sla_due_at`,
        [
          category.id,
          district.id,
          department ? department.id : null,
          citizenId,
          description,
          longitude,
          latitude,
          category.resolution_hours,
        ]
      );

      const {
        rows: [report],
      } = await client.query(
        `INSERT INTO issue_reports (issue_id, citizen_id, description, location, is_original)
         VALUES ($1, $2, $3, ${pointSql('$4', '$5')}, TRUE)
         RETURNING id`,
        [issue.id, citizenId, description, longitude, latitude]
      );

      const photos = [];
      for (const photo of storedPhotos) {
        const {
          rows: [row],
        } = await client.query(
          `INSERT INTO photos
                  (issue_id, issue_report_id, uploaded_by, photo_type,
                   storage_path, mime_type, file_size_bytes)
           VALUES ($1, $2, $3, 'before', $4, $5, $6)
           RETURNING id`,
          [issue.id, report.id, citizenId, photo.storagePath, photo.mimeType, photo.sizeBytes]
        );
        photos.push({ id: Number(row.id), storagePath: photo.storagePath });
      }

      await client.query(
        `INSERT INTO status_history (issue_id, from_status, to_status, changed_by, comment)
         VALUES ($1, NULL, 'new', $2, $3)`,
        [issue.id, citizenId, INITIAL_STATUS_COMMENT]
      );

      await client.query(
        `INSERT INTO issue_subscriptions (issue_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (issue_id, user_id) DO NOTHING`,
        [issue.id, citizenId]
      );

      return { issue, photos };
    })
  );
}

/** Safe response shape: no reporter details, no storage internals. */
function toCreatedIssue({ issue, photos }, context, { description, latitude, longitude }) {
  const { category, district, department } = context;
  return {
    id: Number(issue.id),
    referenceNumber: issue.reference_number,
    status: issue.status,
    reportCount: issue.report_count,
    description,
    category: {
      id: Number(category.id),
      code: category.code,
      nameEn: category.name_en,
      nameSo: category.name_so,
    },
    district: { id: Number(district.id), name: district.name, city: district.city },
    department: department ? { id: Number(department.id), name: department.name } : null,
    location: { latitude, longitude },
    slaDueAt: issue.sla_due_at,
    createdAt: issue.created_at,
    photos: photos.map((p) => ({ id: p.id, url: getPhotoUrl(p.storagePath) })),
  };
}

// ---------------------------------------------------------------------------
// Duplicate candidates (Feature 2, step 5.1: detection only)
// ---------------------------------------------------------------------------

/** Duplicate rules from the brief (Feature 2). Limits are inclusive. */
const DUPLICATE_RADIUS_METRES = 50;
const DUPLICATE_WINDOW_DAYS = 7;
const MAX_DUPLICATE_CANDIDATES = 10;
/** "Open" statuses; resolved and closed issues are never candidates. */
const OPEN_STATUSES = ['new', 'assigned', 'in_progress'];

/**
 * Open, non-sensitive issues of the same category within 50 m of the point
 * and created in the last 7 days, nearest first (max 10).
 *
 * - ST_DWithin / ST_Distance on geography measure in metres and include the
 *   limit (exactly 50 m matches). Both use the same spheroid calculation.
 * - created_at >= now() - 7 days includes exactly 7 days.
 * - Sensitive issues are hidden from citizens (Feature 10 privacy rule).
 * - Uses issues_location_gix and issues_category_status_created_idx.
 *
 * @returns {Promise<Array<object>>} database rows
 */
async function findDuplicateCandidateRows({ citizenId, categoryId, latitude, longitude }) {
  const { rows } = await db.query(
    `SELECT i.id, i.reference_number, i.status, i.report_count, i.created_at,
            c.id AS category_id, c.code AS category_code, c.name_en, c.name_so,
            ST_Distance(i.location, p.point) AS distance_metres,
            EXISTS (
              SELECT 1 FROM issue_reports r
               WHERE r.issue_id = i.id AND r.citizen_id = $4
            ) AS already_reported
       FROM issues i
       JOIN categories c ON c.id = i.category_id
      CROSS JOIN (SELECT ${pointSql('$2', '$3')} AS point) p
      WHERE i.category_id = $1
        AND i.status = ANY($5::text[])
        AND i.is_sensitive = FALSE
        AND i.created_at >= now() - make_interval(days => $6::int)
        AND ST_DWithin(i.location, p.point, $7::float8)
      ORDER BY distance_metres, i.id
      LIMIT $8`,
    [
      categoryId,
      longitude,
      latitude,
      citizenId,
      OPEN_STATUSES,
      DUPLICATE_WINDOW_DAYS,
      DUPLICATE_RADIUS_METRES,
      MAX_DUPLICATE_CANDIDATES,
    ]
  );
  return rows;
}

/**
 * Before photos from the ORIGINAL report of each issue (1–3 each), in upload
 * order. Merged reports' photos are not included, so each candidate shows at
 * most 3 photos.
 * @returns {Promise<Map<string, Array<{ id: number, url: string }>>>} by issue id
 */
async function findOriginalBeforePhotos(issueIds) {
  const byIssue = new Map();
  if (issueIds.length === 0) return byIssue;

  const { rows } = await db.query(
    `SELECT p.id, p.issue_id, p.storage_path
       FROM photos p
       JOIN issue_reports r ON r.id = p.issue_report_id
      WHERE p.issue_id = ANY($1::bigint[])
        AND p.photo_type = 'before'
        AND r.is_original = TRUE
      ORDER BY p.issue_id, p.id`,
    [issueIds]
  );
  for (const row of rows) {
    // A path not made by photoStorage is never turned into a URL.
    if (!isValidStoragePath(row.storage_path)) continue;
    const key = String(row.issue_id);
    if (!byIssue.has(key)) byIssue.set(key, []);
    byIssue.get(key).push({ id: Number(row.id), url: getPhotoUrl(row.storage_path) });
  }
  return byIssue;
}

/**
 * Lists possible duplicates for a report the citizen is about to submit.
 * Read-only. The response never contains reporter details, created_by or
 * storage paths.
 *
 * @param {object} input already validated by the route
 * @param {number} input.citizenId   req.user.id
 * @param {number} input.categoryId
 * @param {number} input.latitude
 * @param {number} input.longitude
 * @returns {Promise<Array<object>>} candidates, nearest first (may be empty)
 */
async function findDuplicateCandidates(input) {
  const rows = await findDuplicateCandidateRows(input);
  const photos = await findOriginalBeforePhotos(rows.map((r) => String(r.id)));

  return rows.map((row) => ({
    id: Number(row.id),
    referenceNumber: row.reference_number,
    status: row.status,
    reportCount: row.report_count,
    createdAt: row.created_at,
    distanceMetres: Math.round(Number(row.distance_metres)),
    category: {
      id: Number(row.category_id),
      code: row.category_code,
      nameEn: row.name_en,
      nameSo: row.name_so,
    },
    photos: photos.get(String(row.id)) || [],
    alreadyReportedByYou: row.already_reported === true,
  }));
}

/**
 * Creates a new issue from a citizen report.
 * @param {object} input already validated by the route
 * @param {number} input.citizenId   req.user.id (role checked by the route)
 * @param {number} input.categoryId
 * @param {string} input.description trimmed, 10+ characters
 * @param {number} input.latitude
 * @param {number} input.longitude
 * @param {number} [input.districtId] fallback when detection is not possible
 * @param {Array}  input.files       verified photos from the upload middleware (1–3)
 * @returns {Promise<object>} created issue (public shape)
 * @throws {AppError} 400 INVALID_CATEGORY / INVALID_DISTRICT,
 *                    422 OUTSIDE_SERVICE_AREA / CATEGORY_UNAVAILABLE
 */
async function createIssue(input) {
  const context = await resolveReportContext(input);
  // Step 5: duplicate detection goes here, before anything is written.
  const saved = await persistNewIssue(input, context);
  return toCreatedIssue(saved, context, input);
}

module.exports = {
  createIssue,
  findDuplicateCandidates,
  DUPLICATE_RADIUS_METRES,
  DUPLICATE_WINDOW_DAYS,
  MAX_DUPLICATE_CANDIDATES,
  OPEN_STATUSES,
  resolveReportContext,
  persistNewIssue,
  OUTSIDE_SERVICE_AREA_MESSAGE,
  INITIAL_STATUS_COMMENT,
};
