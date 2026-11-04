/**
 * Reference data for the citizen report form: issue categories and districts.
 * Tables: categories, districts. Only active rows are returned, and only the
 * columns the form needs (no timestamps, no district boundaries).
 */
const db = require('../config/db');

/**
 * Active issue categories, in their fixed schema order ('other' last).
 * @returns {Promise<Array<{id: number, code: string, nameEn: string, nameSo: string}>>}
 */
async function listActiveCategories() {
  const { rows } = await db.query(
    `SELECT c.id, c.code, c.name_en, c.name_so
       FROM categories c
      WHERE c.is_active = $1
      ORDER BY c.id`,
    [true]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    code: row.code,
    nameEn: row.name_en,
    nameSo: row.name_so,
  }));
}

/**
 * Active districts, sorted by city then name. Used when the district cannot
 * be detected from the report location and the citizen picks one.
 * @returns {Promise<Array<{id: number, name: string, city: string}>>}
 */
async function listActiveDistricts() {
  const { rows } = await db.query(
    `SELECT d.id, d.name, d.city
       FROM districts d
      WHERE d.is_active = $1
      ORDER BY d.city, d.name`,
    [true]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    city: row.city,
  }));
}

module.exports = { listActiveCategories, listActiveDistricts };
