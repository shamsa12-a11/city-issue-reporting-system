/**
 * Runs after express-validator rules and stops the request with a 400 if any
 * rule failed. Response: { error: { code: 'VALIDATION_ERROR', message, details: [{ field, message }] } }
 */
const { validationResult } = require('express-validator');
const AppError = require('../utils/AppError');

function validate(req, _res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  const details = result.array({ onlyFirstError: true }).flatMap((err) =>
    // checkExact() reports all unexpected fields in one error; list each one.
    err.type === 'unknown_fields'
      ? err.fields.map((field) => ({ field: field.path, message: err.msg }))
      : [{ field: err.path, message: err.msg }]
  );
  return next(new AppError(400, 'VALIDATION_ERROR', 'Invalid request data', details));
}

module.exports = validate;
