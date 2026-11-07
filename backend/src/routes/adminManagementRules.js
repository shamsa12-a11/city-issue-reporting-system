/**
 * Validation rules for the admin management endpoints (users, districts,
 * departments, categories). Used by admin.routes inside its exact() wrapper,
 * so unknown body fields and query parameters are rejected.
 */
const { body, param, query } = require('express-validator');
const { pageRules, queryEnum, queryId, bodyId } = require('./validators');
const { normalizePhone, PHONE_REGEX } = require('../utils/phone');
const { MAX_PASSWORD_BYTES } = require('../utils/password');
const { STAFF_ROLES, ALL_ROLES } = require('../services/adminManagement.service');

const MIN_PASSWORD_LENGTH = 8; // same rules as registration
const charLength = (v) => [...v].length;

const idParam = () =>
  param('id')
    .custom((v) => /^\d{1,10}$/.test(v) && Number(v) >= 1 && Number(v) <= 2147483647)
    .withMessage('id must be a positive whole number')
    .bail()
    .toInt();

/** Text of min–max characters containing a letter; trimmed. */
const textRule = (chain, label, { min = 2, max = 100, letters = true } = {}) => {
  let c = chain
    .custom((v) => typeof v === 'string')
    .withMessage(`${label} must be text`)
    .bail()
    .trim()
    .custom((v) => !v.includes('\u0000') && charLength(v) >= min && charLength(v) <= max)
    .withMessage(`${label} must be ${min}–${max} characters`);
  if (letters) c = c.bail().matches(/\p{L}/u).withMessage(`${label} must contain letters`);
  return c;
};

const booleanRule = (field) =>
  body(field).optional().custom((v) => typeof v === 'boolean').withMessage(`${field} must be true or false`);

// ---- GeoJSON boundary (Polygon / MultiPolygon, WGS 84) ----
const isPosition = (p) =>
  Array.isArray(p) && (p.length === 2 || p.length === 3) && p.every(Number.isFinite) && p[0] >= -180 && p[0] <= 180 && p[1] >= -90 && p[1] <= 90;
const isRing = (r) =>
  Array.isArray(r) && r.length >= 4 && r.length <= 2000 && r.every(isPosition) && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1];
const isPolygon = (c) => Array.isArray(c) && c.length >= 1 && c.length <= 50 && c.every(isRing);
function isBoundary(v) {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return false;
  if (Object.keys(v).some((k) => k !== 'type' && k !== 'coordinates')) return false;
  if (v.type === 'Polygon') return isPolygon(v.coordinates);
  if (v.type === 'MultiPolygon') return Array.isArray(v.coordinates) && v.coordinates.length >= 1 && v.coordinates.length <= 50 && v.coordinates.every(isPolygon);
  return false;
}
const boundaryRule = ({ nullable }) =>
  body('boundary')
    .optional({ values: nullable ? 'undefined' : 'null' })
    .custom((v) => (nullable && v === null) || isBoundary(v))
    .withMessage('boundary must be a GeoJSON Polygon or MultiPolygon with closed rings of [longitude, latitude]');

// ---- Users ----
const listUserRules = () => [
  queryEnum('role', ALL_ROLES),
  query('isActive')
    .optional()
    .custom((v) => v === 'true' || v === 'false')
    .withMessage('isActive must be true or false')
    .bail()
    .customSanitizer((v) => v === 'true'),
  queryId('departmentId', 'Department'),
  query('search')
    .optional()
    .custom((v) => typeof v === 'string')
    .withMessage('search must be text')
    .bail()
    .trim()
    .custom((v) => charLength(v) >= 1 && charLength(v) <= 100)
    .withMessage('search must be 1–100 characters'),
  ...pageRules(),
];

const phoneRule = () =>
  body('phoneNumber')
    .custom((v) => typeof v === 'string')
    .withMessage('Phone number is required, as text')
    .bail()
    .customSanitizer(normalizePhone)
    .matches(PHONE_REGEX)
    .withMessage('Phone number must be in international format, e.g. +252610000001');

const passwordRule = () =>
  body('password')
    .custom((v) => typeof v === 'string')
    .withMessage('Password is required, as text')
    .bail()
    .custom((v) => Buffer.byteLength(v, 'utf8') <= MAX_PASSWORD_BYTES && v.length >= MIN_PASSWORD_LENGTH && /\p{L}/u.test(v) && /\d/.test(v))
    .withMessage(`Password must be ${MIN_PASSWORD_LENGTH}+ characters with a letter and a number (at most ${MAX_PASSWORD_BYTES} bytes)`);

const createUserRules = () => [
  textRule(body('fullName'), 'Full name'),
  phoneRule(),
  passwordRule(),
  body('role')
    .custom((v) => typeof v === 'string' && STAFF_ROLES.includes(v))
    .withMessage(`role must be one of: ${STAFF_ROLES.join(', ')} (citizens register themselves)`),
  bodyId('departmentId', 'Department').optional(),
  body('preferredLanguage').optional().isIn(['so', 'en']).withMessage('preferredLanguage must be so or en'),
];

const nullableId = (field, label) =>
  body(field)
    .optional({ values: 'undefined' })
    .custom((v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 2147483647))
    .withMessage(`${label} must be a positive whole number or null`);

const updateUserRules = () => [
  idParam(),
  textRule(body('fullName'), 'Full name').optional(),
  body('role')
    .optional()
    .custom((v) => typeof v === 'string' && ALL_ROLES.includes(v))
    .withMessage(`role must be one of: ${ALL_ROLES.join(', ')}`),
  nullableId('departmentId', 'departmentId'),
  booleanRule('isActive'),
  booleanRule('isOnLeave'),
];

// ---- Districts ----
const nullableRegion = () =>
  body('region')
    .optional({ values: 'undefined' })
    .custom((v) => v === null || (typeof v === 'string' && charLength(v.trim()) >= 2 && charLength(v.trim()) <= 100 && !v.includes('\u0000')))
    .withMessage('region must be 2–100 characters or null')
    .bail()
    .customSanitizer((v) => (v === null ? null : v.trim()));

const createDistrictRules = () => [
  textRule(body('name'), 'Name'),
  textRule(body('city'), 'City'),
  nullableRegion(),
  boundaryRule({ nullable: true }),
];
const updateDistrictRules = () => [
  idParam(),
  textRule(body('name'), 'Name').optional(),
  textRule(body('city'), 'City').optional(),
  nullableRegion(),
  boundaryRule({ nullable: true }),
  booleanRule('isActive'),
];

// ---- Departments ----
const createDepartmentRules = () => [bodyId('districtId', 'District'), textRule(body('name'), 'Name')];
const updateDepartmentRules = () => [idParam(), textRule(body('name'), 'Name').optional(), booleanRule('isActive')];

// ---- Categories ----
const updateCategoryRules = () => [
  idParam(),
  textRule(body('nameEn'), 'nameEn').optional(),
  textRule(body('nameSo'), 'nameSo').optional(),
  booleanRule('isActive'),
];

module.exports = {
  idParam,
  listUserRules,
  createUserRules,
  updateUserRules,
  createDistrictRules,
  updateDistrictRules,
  createDepartmentRules,
  updateDepartmentRules,
  updateCategoryRules,
  isBoundary,
};
