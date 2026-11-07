/**
 * Admin management endpoints (brief §3.4): users and roles, districts,
 * departments, categories. Input is validated by admin.routes; the business
 * rules (last admin, departments, open work) live in adminManagement.service.
 */
const { matchedData } = require('express-validator');
const service = require('../services/adminManagement.service');
const AppError = require('../utils/AppError');
const { DEFAULT_PAGE_SIZE } = require('../routes/validators');

const body = (req) => matchedData(req, { locations: ['body'], includeOptionals: false });
const params = (req) => matchedData(req, { locations: ['params'] });

/** The validated body fields of a PATCH; at least one is required. */
function changesOf(req) {
  const changes = body(req);
  if (Object.keys(changes).length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Send at least one field to change');
  }
  return changes;
}

/** GET /api/admin/users?role=&isActive=&departmentId=&search=&limit=&offset= -> { users, pagination } */
async function listUsers(req, res) {
  const { role = null, isActive = null, departmentId = null, search = null, limit = DEFAULT_PAGE_SIZE, offset = 0 } = matchedData(req, { locations: ['query'] });
  res.json(await service.listUsers({ role, isActive, departmentId, search, limit, offset }));
}

/** GET /api/admin/users/:id -> { user }; 404 USER_NOT_FOUND */
async function getUser(req, res) {
  res.json(await service.getUser({ userId: params(req).id }));
}

/**
 * POST /api/admin/users  body: { fullName, phoneNumber, password, role, departmentId?, preferredLanguage? }
 * 201 { user }. Errors: 400, 404 DEPARTMENT_NOT_FOUND, 409 DEPARTMENT_INACTIVE / PHONE_ALREADY_REGISTERED
 */
async function createUser(req, res) {
  const input = body(req);
  res.status(201).json(await service.createStaffUser({ admin: req.user, ...input, ipAddress: req.ip }));
}

/**
 * PATCH /api/admin/users/:id  body: any of { fullName, role, departmentId, isActive, isOnLeave }
 * 200 { user, changed }. Errors: 400, 404, 409 ROLE_CHANGE_NOT_ALLOWED / CANNOT_CHANGE_OWN_ACCESS /
 *   LAST_ADMIN / OFFICER_HAS_OPEN_ASSIGNMENTS / DEPARTMENT_INACTIVE
 */
async function updateUser(req, res) {
  res.json(await service.updateUser({ admin: req.user, userId: params(req).id, changes: changesOf(req), ipAddress: req.ip }));
}

/** GET /api/admin/districts -> { districts } (active and inactive) */
async function listDistricts(_req, res) {
  res.json(await service.listDistricts());
}

/** POST /api/admin/districts  body: { name, city, region?, boundary? (GeoJSON) } -> 201 { district } */
async function createDistrict(req, res) {
  res.status(201).json(await service.createDistrict({ admin: req.user, ...body(req), ipAddress: req.ip }));
}

/** PATCH /api/admin/districts/:id  body: any of { name, city, region, boundary, isActive } -> { district, changed } */
async function updateDistrict(req, res) {
  res.json(await service.updateDistrict({ admin: req.user, districtId: params(req).id, changes: changesOf(req), ipAddress: req.ip }));
}

/** POST /api/admin/departments  body: { districtId, name } -> 201 { department } */
async function createDepartment(req, res) {
  res.status(201).json(await service.createDepartment({ admin: req.user, ...body(req), ipAddress: req.ip }));
}

/** PATCH /api/admin/departments/:id  body: any of { name, isActive } -> { department, changed } */
async function updateDepartment(req, res) {
  res.json(await service.updateDepartment({ admin: req.user, departmentId: params(req).id, changes: changesOf(req), ipAddress: req.ip }));
}

/** GET /api/admin/categories -> { categories } (active and inactive) */
async function listCategories(_req, res) {
  res.json(await service.listCategories());
}

/** PATCH /api/admin/categories/:id  body: any of { nameEn, nameSo, isActive } -> { category, changed } */
async function updateCategory(req, res) {
  res.json(await service.updateCategory({ admin: req.user, categoryId: params(req).id, changes: changesOf(req), ipAddress: req.ip }));
}

module.exports = {
  listUsers,
  getUser,
  createUser,
  updateUser,
  listDistricts,
  createDistrict,
  updateDistrict,
  createDepartment,
  updateDepartment,
  listCategories,
  updateCategory,
};
