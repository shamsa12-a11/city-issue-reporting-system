/**
 * An expected, client-facing error (bad input, not logged in, forbidden, ...).
 *
 * Throw it anywhere in a request; the central error handler turns it into
 * a JSON response:  { error: { code, message, details? } }
 */
class AppError extends Error {
  /**
   * @param {number} statusCode HTTP status (4xx/5xx).
   * @param {string} code       Stable machine-readable code, e.g. 'INVALID_CREDENTIALS'.
   * @param {string} message    Human-readable message safe to show the user.
   * @param {Array|object} [details] Optional extra info (e.g. validation errors
   *                                per field, or { candidates } for POSSIBLE_DUPLICATES).
   */
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

module.exports = AppError;
