/**
 * Citizen issue reporting (Feature 1) with duplicate detection and merging
 * (Feature 2).
 *
 * createIssue() runs in two phases:
 *   1. resolveReportContext() — read-only checks: category is active and has
 *      an SLA, district from the GPS point (PostGIS), department from
 *      routing_rules. A rejected report never writes a photo to disk.
 *   2. One of two write paths. Each saves the photos, then writes every row in
 *      ONE transaction. If anything fails, the transaction rolls back and the
 *      saved photo files are deleted (withStoredPhotos).
 *        - persistMergedReport() — "Add my report to this issue"
 *          (input.duplicateOfIssueId).
 *        - persistNewIssue()     — a new issue: no candidates nearby, or the
 *          citizen chose "This is different" (input.confirmDifferent).
 *
 * Duplicate rules are enforced on the server, never trusted from the client:
 *   - No decision sent and candidates exist -> 409 POSSIBLE_DUPLICATES, checked
 *     before photos are saved and again inside the transaction.
 *   - A merge target is re-checked inside the transaction while its row is
 *     locked (same category, open, not sensitive, 7 days, 50 m).
 *   - A new issue with a same-category open issue within 10 m (sensitive ones
 *     included) is flagged for supervisor review. The flag is never returned
 *     to the citizen.
 *
 * Routing (Feature 3): a new issue with a department gets its first
 * assignments row (auto_route) in the same transaction. Merges never add one.
 *
 * Tables: categories, slas, districts, routing_rules, departments, issues,
 * assignments, issue_reports, photos, status_history, issue_subscriptions.
 * All SQL is parameterized; all writes use the transaction client.
 */
const db = require('../config/db');
const AppError = require('../utils/AppError');
const { withStoredPhotos, getPhotoUrl, isValidStoragePath } = require('../storage/photoStorage');
const { toSla } = require('./sla');

/** Exact text required by the brief for reports outside every district. */
const OUTSIDE_SERVICE_AREA_MESSAGE = 'Outside service area';

/** Comment on the first status_history row (status_history.comment is required). */
const INITIAL_STATUS_COMMENT = 'Issue reported by citizen';

// GPS point as PostGIS geography. ST_MakePoint takes LONGITUDE first.
const pointSql = (lngParam, latParam) =>
  `ST_SetSRID(ST_MakePoint(${lngParam}::float8, ${latParam}::float8), 4326)::geography`;

// ---------------------------------------------------------------------------
// Duplicate rules (Feature 2)
// ---------------------------------------------------------------------------

/** Duplicate rules from the brief (Feature 2). Limits are inclusive. */
const DUPLICATE_RADIUS_METRES = 50;
const DUPLICATE_WINDOW_DAYS = 7;
const MAX_DUPLICATE_CANDIDATES = 10;
/** "This is different" with an issue this close -> supervisor review. */
const REVIEW_RADIUS_METRES = 10;
/** "Open" statuses; resolved and closed issues are never candidates. */
const OPEN_STATUSES = ['new', 'assigned', 'in_progress'];

/**
 * First key of pg_advisory_xact_lock(key1, key2) used to serialize new-issue
 * creation per category (key2 = category id). Any constant works as long as no
 * other code uses the same one.
 */
const NEW_ISSUE_LOCK_KEY = 5201;

/** How long a transaction waits for a row or advisory lock before giving up. */
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '5s'";

/** Name of the UNIQUE (issue_id, citizen_id) constraint in schema.sql. */
const REPORT_UNIQUE_CONSTRAINT = 'issue_reports_issue_citizen_unique';

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
 *
 * @param {{ query: Function }} [executor] db (pool) or a transaction client
 * @param {{ lock?: boolean }} [options] lock = true (transaction only): FOR SHARE
 *   keeps the rule and the department from changing until the issue and its
 *   assignment are committed.
 */
async function findRoutedDepartment(categoryId, districtId, executor = db, { lock = false } = {}) {
  const { rows } = await executor.query(
    `SELECT dep.id, dep.name
       FROM routing_rules rr
       JOIN departments dep ON dep.id = rr.department_id
      WHERE rr.category_id = $1
        AND rr.district_id = $2
        AND dep.is_active = TRUE${lock ? '\n        FOR SHARE OF rr, dep' : ''}`,
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
// Duplicate candidates (Feature 2)
// ---------------------------------------------------------------------------

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
 * @param {object} input
 * @param {{ query: Function }} [executor] db (pool) or a transaction client
 * @returns {Promise<Array<object>>} database rows
 */
async function findDuplicateCandidateRows(
  { citizenId, categoryId, latitude, longitude },
  executor = db
) {
  const { rows } = await executor.query(
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
 * @param {Array<string>} issueIds
 * @param {{ query: Function }} [executor] db (pool) or a transaction client
 * @returns {Promise<Map<string, Array<{ id: number, url: string }>>>} by issue id
 */
async function findOriginalBeforePhotos(issueIds, executor = db) {
  const byIssue = new Map();
  if (issueIds.length === 0) return byIssue;

  const { rows } = await executor.query(
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
 * Candidate list in its public shape (shared by GET /duplicates and the
 * 409 POSSIBLE_DUPLICATES response).
 * @param {{ query: Function }} [executor] db (pool) or a transaction client
 */
async function loadDuplicateCandidates(input, executor = db) {
  const rows = await findDuplicateCandidateRows(input, executor);
  const photos = await findOriginalBeforePhotos(
    rows.map((r) => String(r.id)),
    executor
  );

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
function findDuplicateCandidates(input) {
  return loadDuplicateCandidates(input);
}

/** 409 asking the citizen to choose: add to an existing issue, or "This is different". */
function possibleDuplicatesError(candidates) {
  return new AppError(
    409,
    'POSSIBLE_DUPLICATES',
    'Similar issues were already reported nearby. Add your report to one of them, or confirm that yours is different.',
    { candidates }
  );
}

/**
 * Same error for an unknown, closed, sensitive, too old, too far or
 * different-category issue, so the response never reveals which (or that a
 * hidden issue exists).
 */
function duplicateNotEligibleError() {
  return new AppError(
    409,
    'DUPLICATE_NOT_ELIGIBLE',
    'This issue can no longer accept reports. Please check for similar issues again.'
  );
}

function alreadyReportedError() {
  return new AppError(409, 'ALREADY_REPORTED', 'You have already reported this issue');
}

// ---------------------------------------------------------------------------
// Phase 2: writes (one transaction per report)
// ---------------------------------------------------------------------------

/**
 * withTransaction() that turns a lock wait timeout (55P03) into a
 * client-facing 503 instead of a 500.
 */
async function runIssueTransaction(work) {
  try {
    return await db.withTransaction(async (client) => {
      await client.query(LOCK_TIMEOUT_SQL);
      return work(client);
    });
  } catch (err) {
    if (err && err.code === '55P03') {
      throw new AppError(503, 'TRY_AGAIN', 'The system is busy. Please try again.');
    }
    throw err;
  }
}

/** Inserts one 'before' photo row per stored file, linked to the report. */
async function insertBeforePhotos(client, { issueId, reportId, citizenId, storedPhotos }) {
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
      [issueId, reportId, citizenId, photo.storagePath, photo.mimeType, photo.sizeBytes]
    );
    photos.push({ id: Number(row.id), storagePath: photo.storagePath });
  }
  return photos;
}

/** Subscribes the citizen to updates for the issue (no-op if already subscribed). */
async function subscribe(client, issueId, citizenId) {
  await client.query(
    `INSERT INTO issue_subscriptions (issue_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (issue_id, user_id) DO NOTHING`,
    [issueId, citizenId]
  );
}

/**
 * Nearest open issue of the same category within 10 m, created in the last
 * 7 days, INCLUDING sensitive issues (internal supervisor check only).
 * @returns {Promise<string|null>} issue id
 */
async function findIssueNeedingReview(client, { categoryId, latitude, longitude }) {
  const { rows } = await client.query(
    `SELECT i.id AS similar_issue_id
       FROM issues i
      WHERE i.category_id = $1
        AND i.status = ANY($4::text[])
        AND i.created_at >= now() - make_interval(days => $5::int)
        AND ST_DWithin(i.location, ${pointSql('$2', '$3')}, $6::float8)
      ORDER BY ST_Distance(i.location, ${pointSql('$2', '$3')}), i.id
      LIMIT 1`,
    [categoryId, longitude, latitude, OPEN_STATUSES, DUPLICATE_WINDOW_DAYS, REVIEW_RADIUS_METRES]
  );
  return rows[0] ? rows[0].similar_issue_id : null;
}

/**
 * First assignment of a routed issue (Feature 3): the department queue, no
 * officer yet. assigned_by NULL = automatic routing (see schema.sql).
 */
async function insertAutoRouteAssignment(client, issueId, departmentId) {
  await client.query(
    `INSERT INTO assignments (issue_id, department_id, assignment_type)
     VALUES ($1, $2, 'auto_route')`,
    [issueId, departmentId]
  );
}

/**
 * Saves the photos and writes issue, its auto_route assignment (if routed),
 * original report, before photos, first status history row and the
 * reporter's subscription in one transaction.
 *
 * Inside the transaction, new issues of the same category are serialized with
 * an advisory lock, so two reports at the same place cannot both miss each
 * other. The duplicate check is then repeated (unless the citizen chose
 * "This is different") and the 10 m supervisor-review check runs.
 *
 * The department is looked up again inside the transaction (locked), so the
 * issue and its assignment always use the rule that was valid at commit time,
 * even if an admin changed it after phase 1.
 *
 * @returns {Promise<{ issue: object, department: object|null,
 *                     photos: Array<{ id: number, storagePath: string }> }>}
 * @throws {AppError} 409 POSSIBLE_DUPLICATES, 503 TRY_AGAIN
 */
async function persistNewIssue(input, context) {
  const { citizenId, description, latitude, longitude, files, confirmDifferent = false } = input;
  const { category, district } = context;

  return withStoredPhotos(files, (storedPhotos) =>
    runIssueTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [
        NEW_ISSUE_LOCK_KEY,
        category.id,
      ]);

      if (!confirmDifferent) {
        // A matching issue may have been created since the first check.
        const candidates = await loadDuplicateCandidates(input, client);
        if (candidates.length > 0) throw possibleDuplicatesError(candidates);
      }

      const similarIssueId = await findIssueNeedingReview(client, {
        categoryId: category.id,
        latitude,
        longitude,
      });

      const department = await findRoutedDepartment(category.id, district.id, client, {
        lock: true,
      });

      // reference_number is generated by the database from the id.
      // sla_due_at uses database time, like created_at.
      const {
        rows: [issue],
      } = await client.query(
        `INSERT INTO issues
                (category_id, district_id, department_id, created_by, description,
                 location, sla_due_at, needs_supervisor_review, similar_issue_id)
         VALUES ($1, $2, $3, $4, $5,
                 ${pointSql('$6', '$7')},
                 now() + make_interval(hours => $8::int), $9, $10)
         RETURNING id, reference_number, status, report_count, created_at, sla_due_at,
                   now() AS sla_evaluated_at`,
        [
          category.id,
          district.id,
          department ? department.id : null,
          citizenId,
          description,
          longitude,
          latitude,
          category.resolution_hours,
          similarIssueId != null,
          similarIssueId,
        ]
      );

      // No department -> no assignment: the issue waits in the Admin Unassigned queue.
      if (department) await insertAutoRouteAssignment(client, issue.id, department.id);

      const {
        rows: [report],
      } = await client.query(
        `INSERT INTO issue_reports (issue_id, citizen_id, description, location, is_original)
         VALUES ($1, $2, $3, ${pointSql('$4', '$5')}, TRUE)
         RETURNING id`,
        [issue.id, citizenId, description, longitude, latitude]
      );

      const photos = await insertBeforePhotos(client, {
        issueId: issue.id,
        reportId: report.id,
        citizenId,
        storedPhotos,
      });

      await client.query(
        `INSERT INTO status_history (issue_id, from_status, to_status, changed_by, comment)
         VALUES ($1, NULL, 'new', $2, $3)`,
        [issue.id, citizenId, INITIAL_STATUS_COMMENT]
      );

      await subscribe(client, issue.id, citizenId);

      return { issue, department, photos };
    })
  );
}

/**
 * Locks the selected issue and re-checks every duplicate rule against THIS
 * report's category and point. Under READ COMMITTED, FOR UPDATE re-evaluates
 * the WHERE clause on the latest row version, so an issue resolved or marked
 * sensitive by a concurrent transaction is not returned.
 * @returns {Promise<object|null>} issue row with its district, or null
 */
async function lockEligibleIssue(client, { issueId, categoryId, latitude, longitude }) {
  const { rows } = await client.query(
    `SELECT i.id, i.reference_number, i.status, i.created_at,
            d.id AS district_id, d.name AS district_name, d.city AS district_city
       FROM issues i
       JOIN districts d ON d.id = i.district_id
      WHERE i.id = $1
        AND i.category_id = $2
        AND i.status = ANY($5::text[])
        AND i.is_sensitive = FALSE
        AND i.created_at >= now() - make_interval(days => $6::int)
        AND ST_DWithin(i.location, ${pointSql('$3', '$4')}, $7::float8)
        FOR UPDATE OF i`,
    [
      issueId,
      categoryId,
      longitude,
      latitude,
      OPEN_STATUSES,
      DUPLICATE_WINDOW_DAYS,
      DUPLICATE_RADIUS_METRES,
    ]
  );
  return rows[0] || null;
}

/**
 * "Add my report to this issue": saves the photos, then in one transaction
 * locks and re-validates the issue, adds a non-original report with its
 * before photos, raises report_count by one and subscribes the citizen.
 * No status_history row: the issue's status does not change.
 *
 * @returns {Promise<{ issue: object, report: object, photos: Array<object> }>}
 * @throws {AppError} 409 DUPLICATE_NOT_ELIGIBLE / ALREADY_REPORTED, 503 TRY_AGAIN
 */
async function persistMergedReport(input, context) {
  const { citizenId, description, latitude, longitude, files, duplicateOfIssueId } = input;
  const { category } = context;

  return withStoredPhotos(files, (storedPhotos) =>
    runIssueTransaction(async (client) => {
      const issue = await lockEligibleIssue(client, {
        issueId: duplicateOfIssueId,
        categoryId: category.id,
        latitude,
        longitude,
      });
      if (!issue) throw duplicateNotEligibleError();

      // Runs after the row lock, so it sees a report committed by a parallel
      // request from the same citizen.
      const { rows: existing } = await client.query(
        `SELECT 1 FROM issue_reports WHERE issue_id = $1 AND citizen_id = $2`,
        [issue.id, citizenId]
      );
      if (existing.length > 0) throw alreadyReportedError();

      let report;
      try {
        ({
          rows: [report],
        } = await client.query(
          `INSERT INTO issue_reports (issue_id, citizen_id, description, location, is_original)
           VALUES ($1, $2, $3, ${pointSql('$4', '$5')}, FALSE)
           RETURNING id, created_at`,
          [issue.id, citizenId, description, longitude, latitude]
        ));
      } catch (err) {
        // Safety net: the UNIQUE (issue_id, citizen_id) constraint.
        if (err && err.code === '23505' && err.constraint === REPORT_UNIQUE_CONSTRAINT) {
          throw alreadyReportedError();
        }
        throw err;
      }

      const photos = await insertBeforePhotos(client, {
        issueId: issue.id,
        reportId: report.id,
        citizenId,
        storedPhotos,
      });

      // Incremented by the database, so concurrent merges never lose a count.
      const {
        rows: [counted],
      } = await client.query(
        `UPDATE issues
            SET report_count = report_count + 1,
                updated_at = now()
          WHERE id = $1
          RETURNING report_count`,
        [issue.id]
      );

      await subscribe(client, issue.id, citizenId);

      return { issue: { ...issue, report_count: counted.report_count }, report, photos };
    })
  );
}

// ---------------------------------------------------------------------------
// Response shapes (no reporter details, no storage internals, no review flag)
// ---------------------------------------------------------------------------

const toPublicCategory = (category) => ({
  id: Number(category.id),
  code: category.code,
  nameEn: category.name_en,
  nameSo: category.name_so,
});

const toPhotoUrls = (photos) => photos.map((p) => ({ id: p.id, url: getPhotoUrl(p.storagePath) }));

/** Safe response shape for a new issue (department = the one used in the transaction). */
function toCreatedIssue({ issue, department, photos }, context, { description, latitude, longitude }) {
  const { category, district } = context;
  return {
    id: Number(issue.id),
    referenceNumber: issue.reference_number,
    status: issue.status,
    reportCount: issue.report_count,
    description,
    category: toPublicCategory(category),
    district: { id: Number(district.id), name: district.name, city: district.city },
    department: department ? { id: Number(department.id), name: department.name } : null,
    location: { latitude, longitude },
    slaDueAt: issue.sla_due_at,
    createdAt: issue.created_at,
    photos: toPhotoUrls(photos),
    // Feature 5: SLA state, from database time (shared calculation).
    sla: toSla({
      status: issue.status,
      createdAt: issue.created_at,
      dueAt: issue.sla_due_at,
      now: issue.sla_evaluated_at,
    }),
  };
}

/**
 * Safe response shape for a merged report. The existing issue's description,
 * reporters and location are not included (same privacy as the candidate list).
 */
function toMergedReport({ issue, report, photos }, context, { description, latitude, longitude }) {
  return {
    issue: {
      id: Number(issue.id),
      referenceNumber: issue.reference_number,
      status: issue.status,
      reportCount: issue.report_count,
      category: toPublicCategory(context.category),
      district: {
        id: Number(issue.district_id),
        name: issue.district_name,
        city: issue.district_city,
      },
      createdAt: issue.created_at,
    },
    report: {
      id: Number(report.id),
      description,
      location: { latitude, longitude },
      createdAt: report.created_at,
      photos: toPhotoUrls(photos),
    },
  };
}

/**
 * Handles a citizen report (POST /api/issues).
 *
 * @param {object} input already validated by the route
 * @param {number} input.citizenId   req.user.id (role checked by the route)
 * @param {number} input.categoryId
 * @param {string} input.description trimmed, 10+ characters
 * @param {number} input.latitude
 * @param {number} input.longitude
 * @param {number} [input.districtId] fallback when detection is not possible
 * @param {number|null} [input.duplicateOfIssueId] "Add my report to this issue"
 * @param {boolean} [input.confirmDifferent] "This is different"
 * @param {Array}  input.files       verified photos from the upload middleware (1–3)
 * @returns {Promise<{ outcome: 'created', issue: object }
 *                 | { outcome: 'merged', issue: object, report: object }>}
 * @throws {AppError} 400 INVALID_CATEGORY / INVALID_DISTRICT,
 *                    409 POSSIBLE_DUPLICATES / DUPLICATE_NOT_ELIGIBLE / ALREADY_REPORTED,
 *                    422 OUTSIDE_SERVICE_AREA / CATEGORY_UNAVAILABLE,
 *                    503 TRY_AGAIN
 */
async function createIssue(input) {
  const context = await resolveReportContext(input);

  if (input.duplicateOfIssueId != null) {
    const saved = await persistMergedReport(input, context);
    return { outcome: 'merged', ...toMergedReport(saved, context, input) };
  }

  if (!input.confirmDifferent) {
    // Checked before any photo is saved; repeated inside the transaction.
    const candidates = await loadDuplicateCandidates(input);
    if (candidates.length > 0) throw possibleDuplicatesError(candidates);
  }

  const saved = await persistNewIssue(input, context);
  return { outcome: 'created', issue: toCreatedIssue(saved, context, input) };
}

module.exports = {
  createIssue,
  findDuplicateCandidates,
  DUPLICATE_RADIUS_METRES,
  DUPLICATE_WINDOW_DAYS,
  MAX_DUPLICATE_CANDIDATES,
  REVIEW_RADIUS_METRES,
  OPEN_STATUSES,
  NEW_ISSUE_LOCK_KEY,
  resolveReportContext,
  runIssueTransaction,
  persistNewIssue,
  persistMergedReport,
  OUTSIDE_SERVICE_AREA_MESSAGE,
  INITIAL_STATUS_COMMENT,
};
