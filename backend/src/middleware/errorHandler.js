/**
 * Central error handling. Every error response has the same shape:
 *   { error: { code, message, details? } }
 * Unexpected errors are logged on the server; the client only gets a generic
 * message so stack traces, SQL and other internals never leak.
 */
const AppError = require('../utils/AppError');
const { env } = require('../config/env');

/** 404 for any route that does not exist. */
function notFound(req, _res, next) {
  next(new AppError(404, 'NOT_FOUND', `Route not found: ${req.method} ${req.path}`));
}

// Express recognises error handlers by their 4 arguments, so _next must stay.
function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    const body = { error: { code: err.code, message: err.message } };
    if (err.details) body.error.details = err.details;
    return res.status(err.statusCode).json(body);
  }

  // Malformed JSON body (thrown by express.json()).
  if (err.type === 'entity.parse.failed') {
    return res
      .status(400)
      .json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  }
  if (err.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
  }

  if (env.nodeEnv !== 'test') {
    console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  }
  return res
    .status(500)
    .json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}

module.exports = { notFound, errorHandler };
