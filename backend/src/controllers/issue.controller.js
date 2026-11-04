/**
 * Issue endpoints. Controllers only translate HTTP <-> service calls;
 * the logic lives in services/issue.service.js.
 */
const { matchedData } = require('express-validator');
const issueService = require('../services/issue.service');

/**
 * POST /api/issues   (citizen only; multipart/form-data)
 * Fields:  categoryId, description, latitude, longitude, districtId? ;
 *          photos: 1–3 JPEG/PNG/WebP files (field "photos")
 * 201:     { issue: { id, referenceNumber, status, reportCount, description,
 *                     category, district, department, location, slaDueAt,
 *                     createdAt, photos: [{ id, url }] } }
 * Errors:  400 VALIDATION_ERROR / INVALID_CATEGORY / INVALID_DISTRICT /
 *              PHOTOS_REQUIRED / TOO_MANY_PHOTOS / INVALID_UPLOAD,
 *          401, 403, 413 PHOTO_TOO_LARGE, 415 UNSUPPORTED_IMAGE_TYPE,
 *          422 OUTSIDE_SERVICE_AREA ("Outside service area") / CATEGORY_UNAVAILABLE,
 *          429 TOO_MANY_REQUESTS
 */
async function create(req, res) {
  const { categoryId, description, latitude, longitude, districtId } = req.body;
  const issue = await issueService.createIssue({
    citizenId: req.user.id,
    categoryId,
    description,
    latitude,
    longitude,
    districtId: districtId || null, // empty = not chosen
    files: req.files,
  });
  res.status(201).json({ issue });
}

/**
 * GET /api/issues/duplicates?categoryId=&latitude=&longitude=   (citizen only)
 * Possible duplicates for a report about to be submitted: open issues of the
 * same category within 50 m, created in the last 7 days. Sensitive issues are
 * never listed. Nearest first, at most 10.
 * 200:     { candidates: [{ id, referenceNumber, status, reportCount, createdAt,
 *                           distanceMetres, category, photos: [{ id, url }],
 *                           alreadyReportedByYou }] }   (may be empty)
 * Errors:  400 VALIDATION_ERROR, 401, 403, 429 TOO_MANY_REQUESTS
 */
async function listDuplicates(req, res) {
  // Express 5 re-parses req.query on every read, so the converted numbers
  // from the validators are read with matchedData(), not req.query.
  const { categoryId, latitude, longitude } = matchedData(req, { locations: ['query'] });
  const candidates = await issueService.findDuplicateCandidates({
    citizenId: req.user.id,
    categoryId,
    latitude,
    longitude,
  });
  res.json({ candidates });
}

module.exports = { create, listDuplicates };
