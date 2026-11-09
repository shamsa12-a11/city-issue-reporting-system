/**
 * Admin endpoints for department routing (Feature 3). Admin only: the router
 * runs authenticate + authorize(admin) before every handler.
 * Input is validated by admin.routes; errors go to the central error handler.
 */
const { matchedData } = require('express-validator');
const routingService = require('../services/routing.service');
const slaService = require('../services/sla.service');

// Express 5 re-parses req.query on every read, so the numbers converted by the
// validators are read with matchedData(), not req.query.
const validQuery = (req) => matchedData(req, { locations: ['query'] });

/**
 * GET /api/admin/routing-rules
 * 200: { rules: [{ category, district, department: { id, name, isActive } | null, routed }],
 *        summary: { total, routed, missing } }
 * Every active category x active district; routed = false means issues of that
 * combination go to the Unassigned queue.
 */
async function listRoutingRules(_req, res) {
  res.json(await routingService.listRoutingRules());
}

/**
 * PUT /api/admin/routing-rules/:categoryId/:districtId   body: { departmentId }
 * 201 (created) / 200 (updated or unchanged): { outcome, rule }
 * Errors: 400 VALIDATION_ERROR / INVALID_DEPARTMENT, 404 CATEGORY_NOT_FOUND /
 *         DISTRICT_NOT_FOUND, 422 DEPARTMENT_NOT_IN_DISTRICT, 503 TRY_AGAIN
 */
async function setRoutingRule(req, res) {
  const result = await routingService.setRoutingRule({
    adminId: req.user.id,
    categoryId: req.params.categoryId,
    districtId: req.params.districtId,
    departmentId: req.body.departmentId,
    ipAddress: req.ip,
  });
  res.status(result.outcome === 'created' ? 201 : 200).json(result);
}

/**
 * GET /api/admin/departments?districtId=
 * 200: { departments: [{ id, name, isActive, district: { id, name, city } }] }
 */
async function listDepartments(req, res) {
  const departments = await routingService.listDepartments({
    districtId: validQuery(req).districtId ?? null,
  });
  res.json({ departments });
}

/** Default page size for the Unassigned queue (the route allows up to 100). */
const DEFAULT_PAGE_SIZE = 20;

/**
 * GET /api/admin/issues/unassigned?limit=&offset=
 * 200: { issues: [...], pagination: { limit, offset, total } }   (oldest first)
 */
async function listUnassignedIssues(req, res) {
  const { limit = DEFAULT_PAGE_SIZE, offset = 0 } = validQuery(req);
  const result = await routingService.listUnassignedIssues({ limit, offset });
  res.json(result);
}

/**
 * GET /api/admin/issues?status=&districtId=&categoryId=&departmentId=&search=&limit=&offset=
 * Every issue (sensitive included), newest first. search = reference number.
 * 200: { issues: [...], pagination: { limit, offset, total } }
 */
async function listAllIssues(req, res) {
  const { status = 'all', districtId = null, categoryId = null, departmentId = null, search = null, limit = DEFAULT_PAGE_SIZE, offset = 0 } = validQuery(req);
  res.json(await routingService.listAllIssues({ status, districtId, categoryId, departmentId, search, limit, offset }));
}

/**
 * POST /api/admin/issues/:id/reroute   body: { departmentId, reason }
 * 200: { issue: { id, referenceNumber, status, previousDepartment, department },
 *        assignment: { id, type: 'manual_reroute', reason, assignedAt } }
 * Errors: 400 VALIDATION_ERROR / INVALID_DEPARTMENT, 404 ISSUE_NOT_FOUND,
 *         409 ISSUE_NOT_OPEN / SAME_DEPARTMENT, 503 TRY_AGAIN
 */
async function rerouteIssue(req, res) {
  const result = await routingService.rerouteIssue({
    adminId: req.user.id,
    issueId: req.params.id,
    departmentId: req.body.departmentId,
    reason: req.body.reason,
    ipAddress: req.ip,
  });
  res.json(result);
}

/**
 * GET /api/admin/slas   (Feature 5)
 * 200: { slas: [{ category: { id, code, nameEn, nameSo, isActive },
 *                 resolutionHours | null, updatedAt, updatedBy: { id, name } | null }] }
 */
async function listSlas(_req, res) {
  res.json({ slas: await slaService.listSlas() });
}

/**
 * PUT /api/admin/slas/:categoryId   body: { resolutionHours }   (Feature 5)
 * 201 (created) / 200 (updated or unchanged): { outcome, sla }
 * Applies to issues created afterwards; existing deadlines never change.
 * Errors: 400 VALIDATION_ERROR, 404 CATEGORY_NOT_FOUND, 503 TRY_AGAIN
 */
async function setSla(req, res) {
  const result = await slaService.setSla({
    adminId: req.user.id,
    categoryId: req.params.categoryId,
    resolutionHours: req.body.resolutionHours,
    ipAddress: req.ip,
  });
  res.status(result.outcome === 'created' ? 201 : 200).json(result);
}

module.exports = {
  listRoutingRules,
  setRoutingRule,
  listDepartments,
  listUnassignedIssues,
  listAllIssues,
  rerouteIssue,
  listSlas,
  setSla,
  DEFAULT_PAGE_SIZE,
};
