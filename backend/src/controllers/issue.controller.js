/**
 * Issue endpoints. Controllers only translate HTTP <-> service calls;
 * the logic lives in services/issue.service.js.
 */
const { matchedData } = require('express-validator');
const issueService = require('../services/issue.service');

/**
 * POST /api/issues   (citizen only; multipart/form-data)
 * Fields:  categoryId, description, latitude, longitude, districtId? ;
 *          photos: 1–3 JPEG/PNG/WebP files (field "photos");
 *          at most ONE duplicate decision:
 *            duplicateOfIssueId — "Add my report to this issue"
 *            confirmDifferent=true — "This is different"
 * 201 (new issue):
 *          { outcome: 'created',
 *            issue: { id, referenceNumber, status, reportCount, description,
 *                     category, district, department, location, slaDueAt,
 *                     createdAt, photos: [{ id, url }] } }
 * 201 (merged into an existing issue):
 *          { outcome: 'merged',
 *            issue:  { id, referenceNumber, status, reportCount, category,
 *                      district, createdAt },
 *            report: { id, description, location, createdAt, photos: [{ id, url }] } }
 * Errors:  400 VALIDATION_ERROR / INVALID_CATEGORY / INVALID_DISTRICT /
 *              PHOTOS_REQUIRED / TOO_MANY_PHOTOS / INVALID_UPLOAD,
 *          401, 403,
 *          409 POSSIBLE_DUPLICATES (no decision sent and similar issues exist;
 *              error.details.candidates has the same shape as GET /duplicates)
 *              / DUPLICATE_NOT_ELIGIBLE / ALREADY_REPORTED,
 *          413 PHOTO_TOO_LARGE, 415 UNSUPPORTED_IMAGE_TYPE,
 *          422 OUTSIDE_SERVICE_AREA ("Outside service area") / CATEGORY_UNAVAILABLE,
 *          429 TOO_MANY_REQUESTS, 503 TRY_AGAIN
 */
async function create(req, res) {
  const { categoryId, description, latitude, longitude, districtId, duplicateOfIssueId, confirmDifferent } =
    req.body;
  const result = await issueService.createIssue({
    citizenId: req.user.id,
    categoryId,
    description,
    latitude,
    longitude,
    districtId: districtId || null, // empty = not chosen
    duplicateOfIssueId: duplicateOfIssueId || null, // empty = no merge
    confirmDifferent: confirmDifferent === true, // converted by the route rules
    files: req.files,
  });
  res.status(201).json(result);
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
