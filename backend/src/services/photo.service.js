/**
 * Before / after photos of an issue (Feature 8), filtered by who is looking.
 *
 *   before  photos citizens sent with their reports (photo_type 'before')
 *   after   photos the officer took at the issue location when resolving
 *   reopen  photos a citizen sent when reopening (never public)
 *
 * Who sees what:
 *   staff (anyone who may see the issue: assigned officer, department
 *     supervisor, admin): every before, after and reopen photo; after photos
 *     carry the resolution they belong to.
 *   linked citizen: the original report's before photos and their own, the
 *     after photos of the LATEST resolution while the issue is resolved or
 *     closed, and their own reopen photos.
 *   public (Feature 10, never sensitive issues): the original report's before
 *     photos and the latest resolution's after photos while resolved/closed.
 * Uploader ids and other citizens' photos are never returned to citizens or
 * the public.
 *
 * Tables: photos, issue_reports, status_history. All SQL is parameterized.
 */
const db = require('../config/db');
const { getPhotoUrl } = require('../storage/photoStorage');
const { findVisibleIssue } = require('./status.service');

const FIXED_STATUSES = ['resolved', 'closed'];
const STAFF_ROLES = ['officer', 'supervisor', 'admin'];

/** Every photo of the issue with its report and whether it is from the latest resolution. */
async function loadPhotos(executor, issueId) {
  const { rows } = await executor.query(
    `SELECT p.id AS photo_id, p.photo_type, p.storage_path, p.created_at,
            p.status_history_id, p.uploaded_by,
            r.is_original, r.citizen_id AS report_citizen_id,
            (p.status_history_id IS NOT NULL
             AND p.status_history_id = (SELECT h.id
                                          FROM status_history h
                                         WHERE h.issue_id = $1
                                           AND h.to_status = 'resolved'
                                         ORDER BY h.created_at DESC, h.id DESC
                                         LIMIT 1)) AS from_latest_resolution
       FROM photos p
       LEFT JOIN issue_reports r ON r.id = p.issue_report_id
      WHERE p.issue_id = $1
      ORDER BY p.created_at, p.id`,
    [issueId]
  );
  return rows;
}

const sameId = (a, b) => a != null && b != null && Number(a) === Number(b);
const toPhoto = (row) => ({ id: Number(row.photo_id), url: getPhotoUrl(row.storage_path), createdAt: row.created_at });

/**
 * @param {Array} rows from loadPhotos
 * @param {{ status: string }} issue
 * @param {'staff'|'citizen'|'public'} audience
 * @param {number|string} [viewerId] the citizen (audience 'citizen')
 */
function filterPhotos(rows, issue, audience, viewerId) {
  const showAfter = FIXED_STATUSES.includes(issue.status);
  if (audience === 'staff') {
    return {
      before: rows.filter((r) => r.photo_type === 'before').map(toPhoto),
      after: rows
        .filter((r) => r.photo_type === 'after')
        .map((r) => ({ ...toPhoto(r), resolutionId: Number(r.status_history_id), isLatestResolution: r.from_latest_resolution === true })),
      reopen: rows.filter((r) => r.photo_type === 'reopen').map(toPhoto),
    };
  }
  const own = (r) => audience === 'citizen' && sameId(r.report_citizen_id, viewerId);
  const result = {
    before: rows.filter((r) => r.photo_type === 'before' && (r.is_original === true || own(r))).map(toPhoto),
    after: showAfter ? rows.filter((r) => r.photo_type === 'after' && r.from_latest_resolution === true).map(toPhoto) : [],
  };
  if (audience === 'citizen') {
    result.reopen = rows.filter((r) => r.photo_type === 'reopen' && sameId(r.uploaded_by, viewerId)).map(toPhoto);
  }
  return result;
}

/**
 * GET /api/issues/:id/photos for a logged-in user who may see the issue
 * (same visibility as the status view; otherwise 404).
 * @throws {AppError} 404 ISSUE_NOT_FOUND
 */
async function getIssuePhotos({ user, issueId }) {
  const { issue } = await findVisibleIssue(db, issueId, user);
  const rows = await loadPhotos(db, issue.id);
  const audience = STAFF_ROLES.includes(user.role) ? 'staff' : 'citizen';
  return {
    issue: { id: Number(issue.id), referenceNumber: issue.reference_number, status: issue.status },
    photos: filterPhotos(rows, issue, audience, user.id),
  };
}

/** Public before/after photos (caller has checked the issue is not sensitive). */
async function getPublicPhotos(executor, issue) {
  return filterPhotos(await loadPhotos(executor, issue.id), issue, 'public');
}

module.exports = { getIssuePhotos, getPublicPhotos, filterPhotos, loadPhotos };
