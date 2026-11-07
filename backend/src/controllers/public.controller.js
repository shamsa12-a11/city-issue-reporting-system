/**
 * Public issue status (Feature 10, no login), the logged-in photo view
 * (Feature 8) and the admin "sensitive" switch. Input is validated by the
 * routes; errors go to the error handler.
 */
const { matchedData } = require('express-validator');
const publicIssueService = require('../services/publicIssue.service');
const photoService = require('../services/photo.service');
const { DEFAULT_PAGE_SIZE } = require('../routes/validators');

/**
 * GET /api/public/issues?districtId=&categoryId=&status=&sort=newest|upvotes&limit=&offset=   (public)
 * 200: { issues: [{ referenceNumber, category, district, status, reportCount,
 *                   upvoteCount, reportedAt, location: { latitude, longitude } }], pagination }
 */
async function listIssues(req, res) {
  const { districtId, categoryId, status, sort, limit = DEFAULT_PAGE_SIZE, offset = 0 } = matchedData(req, { locations: ['query'] });
  res.json(await publicIssueService.listPublicIssues({ districtId, categoryId, status, sort, limit, offset }));
}

/**
 * GET /api/public/issues/:referenceNumber   (public)
 * 200: { issue: { ...as the list, photos: { before: [...], after: [...] } } }
 * Errors: 400 VALIDATION_ERROR, 404 ISSUE_NOT_FOUND (unknown or sensitive)
 */
async function getIssue(req, res) {
  const { referenceNumber } = matchedData(req, { locations: ['params'] });
  res.json(await publicIssueService.getPublicIssue({ referenceNumber }));
}

/**
 * GET /api/issues/:id/photos   (any logged-in user who may see the issue)
 * 200: { issue: { id, referenceNumber, status }, photos: { before, after, reopen } }
 * Errors: 400, 401, 404 ISSUE_NOT_FOUND
 */
async function issuePhotos(req, res) {
  res.json(await photoService.getIssuePhotos({ user: req.user, issueId: req.params.id }));
}

/**
 * PATCH /api/admin/issues/:id/sensitive   body: { isSensitive: true|false }   (admin)
 * 200: { issue: { id, referenceNumber, isSensitive }, changed }
 * Errors: 400, 401, 403, 404 ISSUE_NOT_FOUND, 503 TRY_AGAIN
 */
async function setSensitive(req, res) {
  res.json(
    await publicIssueService.setSensitive({
      user: req.user,
      issueId: req.params.id,
      isSensitive: req.body.isSensitive,
      ipAddress: req.ip,
    })
  );
}

module.exports = { listIssues, getIssue, issuePhotos, setSensitive };
