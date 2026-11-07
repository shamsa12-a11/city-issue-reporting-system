/**
 * District performance report (Feature 13). Input is validated by the
 * routes; the district scope is set by report.service from the user.
 */
const { matchedData } = require('express-validator');
const reportService = require('../services/report.service');

/**
 * GET /api/admin/reports/district-performance?from=&to=&categoryId=&districtId=
 * GET /api/supervisor/reports/district-performance?from=&to=&categoryId=   (own district)
 * 200: { filters, totals, monthly: [{ month, ...metrics }],
 *        districts: [{ district, metrics, monthly }], generatedAt }
 * metrics: { received, resolved, averageResolutionHours, slaBreaches,
 *            slaBreachPercent, reopened, reopenedRate }
 * Errors: 400 VALIDATION_ERROR / RANGE_TOO_LONG, 401, 403
 */
async function districtPerformance(req, res) {
  const { from, to, categoryId, districtId } = matchedData(req, { locations: ['query'] });
  res.json(
    await reportService.getDistrictPerformance({
      user: req.user,
      from: from ?? null,
      to: to ?? null,
      categoryId: categoryId ?? null,
      districtId: districtId ?? null,
    })
  );
}

module.exports = { districtPerformance };
