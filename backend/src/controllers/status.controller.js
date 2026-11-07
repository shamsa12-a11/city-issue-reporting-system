/**
 * Issue status workflow endpoints (Feature 4). Input is validated by
 * issues.routes; permissions on the issue itself are checked by
 * status.service inside the transaction. Errors go to the error handler.
 */
const statusService = require('../services/status.service');

/**
 * GET /api/issues/:id/status   (any logged-in user who may see the issue)
 * 200: { issue: { id, referenceNumber, status, reopenCount, resolvedAt,
 *                 reopenDeadline, closedAt,
 *                 canReopen (citizens) | department, currentAssignment (staff) },
 *        history: [{ id, fromStatus, toStatus, comment, isReopen, changedBy, createdAt }] }
 * Errors: 400 VALIDATION_ERROR, 401, 404 ISSUE_NOT_FOUND
 */
async function getStatus(req, res) {
  res.json(await statusService.getIssueStatus({ user: req.user, issueId: req.params.id }));
}

/**
 * PATCH /api/issues/:id/status   (officer, supervisor)
 *   body: { status, comment }                      a status change, or
 *   body: { subStatus: 'waiting_for_materials' | null, comment }
 *                                                  set / clear the sub-status (Feature 5)
 *   (exactly one of status / subStatus)
 * 200: { issue, historyEntry }
 * Errors: 400 VALIDATION_ERROR, 401, 403, 404 ISSUE_NOT_FOUND,
 *         409 INVALID_TRANSITION / OFFICER_REQUIRED / SUB_STATUS_NOT_ALLOWED /
 *             SUB_STATUS_UNCHANGED, 429, 503 TRY_AGAIN
 */
async function updateStatus(req, res) {
  const input = { user: req.user, issueId: req.params.id, comment: req.body.comment };
  const result =
    req.body.subStatus !== undefined
      ? await statusService.updateSubStatus({ ...input, subStatus: req.body.subStatus })
      : await statusService.updateStatus({ ...input, status: req.body.status });
  res.json(result);
}

/**
 * POST /api/issues/:id/resolve   (assigned officer; multipart)
 * Fields: comment, latitude, longitude (where the photos were taken, Feature 8);
 *         photos: 1–3 after photos (field "photos")
 * 200: { issue, historyEntry, photos: [{ id, url }] }
 * Errors: 400 VALIDATION_ERROR / PHOTOS_REQUIRED / TOO_MANY_PHOTOS / INVALID_UPLOAD,
 *         401, 403 / NOT_ASSIGNED_OFFICER, 404 ISSUE_NOT_FOUND, 409 INVALID_TRANSITION,
 *         422 AFTER_PHOTO_NOT_AT_LOCATION,
 *         413 PHOTO_TOO_LARGE, 415 UNSUPPORTED_IMAGE_TYPE, 429, 503 TRY_AGAIN
 */
async function resolve(req, res) {
  const result = await statusService.resolveIssue({
    user: req.user,
    issueId: req.params.id,
    comment: req.body.comment,
    files: req.files,
    takenAt: { latitude: req.body.latitude, longitude: req.body.longitude },
  });
  res.json(result);
}

/**
 * POST /api/issues/:id/reopen   (linked citizen; multipart)
 * Fields: comment; photos: 1–3 photos (field "photos")
 * 200: { issue, historyEntry, photos: [{ id, url }] }
 * Errors: 400 (as resolve), 401, 403, 404 ISSUE_NOT_FOUND,
 *         409 ISSUE_NOT_RESOLVED / REOPEN_WINDOW_EXPIRED, 413, 415, 429, 503 TRY_AGAIN
 */
async function reopen(req, res) {
  const result = await statusService.reopenIssue({
    user: req.user,
    issueId: req.params.id,
    comment: req.body.comment,
    files: req.files,
  });
  res.json(result);
}

module.exports = { getStatus, updateStatus, resolve, reopen };
