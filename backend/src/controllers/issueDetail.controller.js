/**
 * Citizen "my reports" and fix rating, the supervisor duplicate-review queue
 * and the staff issue detail. Input is validated by the routes; visibility
 * and ownership are checked by issueDetail.service.
 */
const { matchedData } = require('express-validator');
const service = require('../services/issueDetail.service');
const { DEFAULT_PAGE_SIZE } = require('../routes/validators');

const page = (req) => {
  const { status, limit = DEFAULT_PAGE_SIZE, offset = 0 } = matchedData(req, { locations: ['query'] });
  return { status, limit, offset };
};

/**
 * GET /api/issues/mine?status=all|open|resolved|closed&limit=&offset=   (citizen)
 * 200: { issues: [{ id, referenceNumber, status, subStatus, category, district, reportCount,
 *                   upvoteCount, createdAt, sla, myReport: { id, isOriginal, description,
 *                   reportedAt, fixRating, ratedAt }, canRate }], pagination }
 */
async function myReports(req, res) {
  const { status = 'all', limit, offset } = page(req);
  res.json(await service.listMyReports({ user: req.user, status, limit, offset }));
}

/**
 * PUT /api/issues/:id/rating   (citizen linked to the issue)   body: { rating: 1–5 }
 * 200: { issue: { id, referenceNumber, status }, rating: { fixRating, ratedAt } }
 * Errors: 400, 401, 403, 404 ISSUE_NOT_FOUND, 409 ISSUE_NOT_RESOLVED, 429, 503 TRY_AGAIN
 */
async function rate(req, res) {
  res.json(await service.rateFix({ user: req.user, issueId: req.params.id, rating: req.body.rating }));
}

/**
 * GET /api/supervisor/review-issues?status=open|all&limit=&offset=   (supervisor, own department)
 * 200: { issues: [{ ..., similarIssue: { id, referenceNumber, status, distanceMetres } | null }], pagination }
 */
async function reviewIssues(req, res) {
  const { status = 'open', limit, offset } = page(req);
  res.json(await service.listReviewIssues({ user: req.user, status, limit, offset }));
}

/**
 * GET /api/issues/:id   (officer, supervisor or admin who may see the issue)
 * 200: { issue: { ...details, sla, slaEscalation, currentAssignment, supervisorReview,
 *                 fixRating, reports, photos } }
 * Errors: 400, 401, 403 (citizen), 404 ISSUE_NOT_FOUND
 */
async function detail(req, res) {
  res.json(await service.getIssueDetail({ user: req.user, issueId: req.params.id }));
}

module.exports = { myReports, rate, reviewIssues, detail };
