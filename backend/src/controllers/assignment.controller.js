/**
 * Officer assignment and workload endpoints (Feature 7). Input is validated by
 * the routes; department scope and officer checks are done by
 * assignment.service inside the transaction. Errors go to the error handler.
 */
const { matchedData } = require('express-validator');
const assignmentService = require('../services/assignment.service');
const { DEFAULT_PAGE_SIZE } = require('../routes/validators');

const page = (req) => {
  const { limit = DEFAULT_PAGE_SIZE, offset = 0, status } = matchedData(req, { locations: ['query'] });
  return { limit, offset, status };
};

/**
 * POST /api/issues/:id/assign   (supervisor of the issue's department)
 * body: { officerId, reason?, comment? }  reason is required when replacing an officer
 * 200: { issue, assignment: { id, type, officer: { id, name }, reason, assignedAt },
 *        previousOfficer: { id, name } | null }
 * Errors: 400 VALIDATION_ERROR / INVALID_OFFICER / REASON_REQUIRED, 401, 403,
 *         404 ISSUE_NOT_FOUND, 409 ISSUE_NOT_OPEN / OFFICER_UNAVAILABLE / SAME_OFFICER,
 *         429, 503 TRY_AGAIN
 */
async function assign(req, res) {
  const result = await assignmentService.assignOfficer({
    user: req.user,
    issueId: req.params.id,
    officerId: req.body.officerId,
    reason: req.body.reason,
    comment: req.body.comment,
    ipAddress: req.ip,
  });
  res.json(result);
}

/**
 * GET /api/supervisor/issues?status=new|assigned|in_progress|open&limit=&offset=
 * 200: { issues: [{ ..., officer: { id, name } | null, sla }], pagination }
 */
async function listDepartmentIssues(req, res) {
  const { limit, offset, status = 'new' } = page(req);
  res.json(await assignmentService.listDepartmentIssues({ user: req.user, status, limit, offset }));
}

/**
 * GET /api/supervisor/workload
 * 200: { department: { id, name }, officers: [{ id, name, isOnLeave, isActive, openAssignedCount }] }
 */
async function workload(req, res) {
  res.json(await assignmentService.getWorkload({ user: req.user }));
}

/**
 * GET /api/officer/issues?status=open|resolved|closed|all&limit=&offset=
 * 200: { issues: [...], pagination }   (only the officer's current assignments)
 */
async function listOfficerIssues(req, res) {
  const { limit, offset, status = 'open' } = page(req);
  res.json(await assignmentService.listOfficerIssues({ user: req.user, status, limit, offset }));
}

module.exports = { assign, listDepartmentIssues, workload, listOfficerIssues };
