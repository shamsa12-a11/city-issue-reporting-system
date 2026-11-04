/**
 * Public reference data for the citizen report form. No login required.
 * Database errors are passed to the central error handler (500 INTERNAL_ERROR).
 */
const referenceService = require('../services/reference.service');

/**
 * GET /api/categories   (public)
 * 200: { categories: [{ id, code, nameEn, nameSo }] }   (active only; may be empty)
 */
async function listCategories(_req, res) {
  const categories = await referenceService.listActiveCategories();
  res.json({ categories });
}

/**
 * GET /api/districts   (public)
 * 200: { districts: [{ id, name, city }] }   (active only; may be empty)
 */
async function listDistricts(_req, res) {
  const districts = await referenceService.listActiveDistricts();
  res.json({ districts });
}

module.exports = { listCategories, listDistricts };
