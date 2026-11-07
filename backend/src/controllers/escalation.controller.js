/**
 * SLA escalation endpoints and staff comments (Feature 6). Input is validated
 * by the routes; visibility is checked by the services. Errors go to the
 * error handler.
 */
const { matchedData } = require('express-validator');
const escalationService = require('../services/escalation.service');
const commentService = require('../services/comment.service');
const { DEFAULT_PAGE_SIZE } = require('../routes/validators');

const page = (req) => {
  const { limit = DEFAULT_PAGE_SIZE, offset = 0, state } = matchedData(req, { locations: ['query'] });
  return { limit, offset, state };
};

/**
 * POST /api/issues/:id/comments   (officer, supervisor, admin who may see the issue)
 * body: { body }  1–1000 characters
 * 201: { comment: { id, body, author: { id, name, role }, createdAt },
 *        escalationActioned: null | { actionedAt, onTime } }
 * Errors: 400 VALIDATION_ERROR, 401, 403 (citizen), 404 ISSUE_NOT_FOUND, 429, 503 TRY_AGAIN
 */
async function addComment(req, res) {
  const result = await commentService.addComment({
    user: req.user,
    issueId: req.params.id,
    body: req.body.body,
    ipAddress: req.ip,
  });
  res.status(201).json(result);
}

/**
 * GET /api/issues/:id/comments?limit=&offset=   (staff who may see the issue)
 * 200: { comments: [...], pagination }
 */
async function listComments(req, res) {
  const { limit, offset } = page(req);
  res.json(await commentService.listComments({ user: req.user, issueId: req.params.id, limit, offset }));
}

/**
 * GET /api/supervisor/escalations?state=pending|actioned|admin_alerted|all  (default pending)
 * GET /api/admin/escalations?state=...                                      (default admin_alerted)
 * 200: { issues: [{ ..., sla, slaEscalation }], pagination }
 */
const listEscalations = (defaultState) => async (req, res) => {
  const { limit, offset, state = defaultState } = page(req);
  res.json(await escalationService.listEscalations({ user: req.user, state, limit, offset }));
};

module.exports = {
  addComment,
  listComments,
  supervisorEscalations: listEscalations('pending'),
  adminEscalations: listEscalations('admin_alerted'),
};
