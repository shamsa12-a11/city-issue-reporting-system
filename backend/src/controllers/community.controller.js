/**
 * Upvotes (Feature 11) and the live heatmap (Feature 12). Input is validated
 * by the routes; errors go to the error handler.
 */
const { matchedData } = require('express-validator');
const upvoteService = require('../services/upvote.service');
const heatmapService = require('../services/heatmap.service');

const reference = (req) => matchedData(req, { locations: ['params'] }).referenceNumber;

/**
 * POST /api/public/issues/:referenceNumber/upvote   (citizen)
 * 201: { referenceNumber, upvoted: true, upvotedAt, upvoteCount }
 * Errors: 400, 401, 403, 404 ISSUE_NOT_FOUND, 409 ISSUE_NOT_OPEN / ALREADY_UPVOTED, 429, 503
 */
async function upvote(req, res) {
  res.status(201).json(await upvoteService.upvote({ user: req.user, referenceNumber: reference(req) }));
}

/**
 * GET /api/public/issues/:referenceNumber/upvote   (citizen)
 * 200: { referenceNumber, upvoted, upvotedAt, canUpvote, upvoteCount }
 */
async function myUpvote(req, res) {
  res.json(await upvoteService.getMyUpvote({ user: req.user, referenceNumber: reference(req) }));
}

/**
 * GET /api/public/heatmap | /api/supervisor/heatmap | /api/admin/heatmap
 *   ?categoryId=&districtId=&from=YYYY-MM-DD&to=YYYY-MM-DD   (no districtId for supervisors)
 * 200: { filters, points: [{ latitude, longitude, weight }],
 *        summary: { issueCount, totalWeight, maxWeight, truncated },
 *        message: null | { en, so }, generatedAt }
 */
const heatmap = (audience) => async (req, res) => {
  const { categoryId, districtId, from, to } = matchedData(req, { locations: ['query'] });
  res.json(
    await heatmapService.getHeatmap({
      user: audience === 'public' ? null : req.user,
      audience,
      categoryId: categoryId ?? null,
      districtId: districtId ?? null,
      from: from ?? null,
      to: to ?? null,
    })
  );
};

module.exports = {
  upvote,
  myUpvote,
  publicHeatmap: heatmap('public'),
  supervisorHeatmap: heatmap('supervisor'),
  adminHeatmap: heatmap('admin'),
};
