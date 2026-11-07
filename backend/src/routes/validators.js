/**
 * Shared request validators for list endpoints (Feature 7 onward):
 * paging, one-value enum filters, JSON ids and optional texts.
 * Query values are converted here; controllers read them with matchedData()
 * (Express 5 re-parses req.query on every read).
 */
const { body, query, checkExact } = require('express-validator');

const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = 1_000_000;
const DEFAULT_PAGE_SIZE = 20;

/** Counts characters the way PostgreSQL length() does (code points). */
const charLength = (value) => [...value].length;

/** Optional whole-number query parameter in [min, max], sent once, as text. */
const queryInt = (field, label, { min, max }) =>
  query(field)
    .optional()
    .custom((v) => typeof v === 'string' && /^\d{1,7}$/.test(v) && Number(v) >= min && Number(v) <= max)
    .withMessage(`${label} must be a whole number from ${min} to ${max}`)
    .bail()
    .toInt();

/** limit (1–100) and offset (0–1,000,000). */
const pageRules = () => [
  queryInt('limit', 'limit', { min: 1, max: MAX_PAGE_SIZE }),
  queryInt('offset', 'offset', { min: 0, max: MAX_OFFSET }),
];

/** Optional query parameter that must be one of `allowed`, sent once. */
const queryEnum = (field, allowed) =>
  query(field)
    .optional()
    .custom((v) => typeof v === 'string' && allowed.includes(v))
    .withMessage(`${field} must be one of: ${allowed.join(', ')}`);

/** Required positive id in a JSON body: a JSON number or digit text. */
const bodyId = (field, label) =>
  body(field)
    .exists({ values: 'null' })
    .withMessage(`${label} is required`)
    .bail()
    .custom((v) => {
      const text = typeof v === 'number' || typeof v === 'string' ? String(v).trim() : '';
      return /^\d{1,16}$/.test(text) && Number(text) >= 1 && Number(text) <= Number.MAX_SAFE_INTEGER;
    })
    .withMessage(`${label} must be a positive whole number`)
    .bail()
    .customSanitizer((v) => Number(String(v).trim()));

/** Optional trimmed text of min–max characters (no NUL), sent once. */
const optionalText = (field, label, { min, max }) =>
  body(field)
    .optional()
    .custom((v) => typeof v === 'string')
    .withMessage(`${label} must be text`)
    .bail()
    .trim()
    .custom((v) => !v.includes('\u0000'))
    .withMessage(`${label} contains invalid characters`)
    .bail()
    .custom((v) => charLength(v) >= min && charLength(v) <= max)
    .withMessage(`${label} must be ${min}–${max} characters`);

/** Optional positive id query filter, sent once, as digits. */
const queryId = (field, label) =>
  query(field)
    .optional()
    .custom((v) => typeof v === 'string' && /^\d{1,9}$/.test(v) && Number(v) >= 1)
    .withMessage(`${label} must be a positive whole number`)
    .bail()
    .toInt();

/** Optional calendar date YYYY-MM-DD (a real date), sent once; kept as text. */
const queryDate = (field, label) =>
  query(field)
    .optional()
    .custom((v) => {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
      const d = new Date(`${v}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
    })
    .withMessage(`${label} must be a date like 2026-11-04`);

/** Rejects unknown body fields and query parameters. */
const exact = (chains) => checkExact(chains, { message: 'Unknown field(s) in request', locations: ['body', 'query'] });

/**
 * Heatmap filters (Feature 12): category, optional district, inclusive date
 * range from <= to.
 */
const heatmapRules = ({ district = true } = {}) => [
  queryId('categoryId', 'Category'),
  ...(district ? [queryId('districtId', 'District')] : []),
  queryDate('from', 'from'),
  queryDate('to', 'to').bail().custom((to, { req }) => {
    const from = req.query.from;
    if (typeof from === 'string' && from > to) throw new Error('from must be on or before to');
    return true;
  }),
];

module.exports = {
  pageRules,
  queryEnum,
  queryId,
  queryDate,
  heatmapRules,
  bodyId,
  optionalText,
  exact,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
};
