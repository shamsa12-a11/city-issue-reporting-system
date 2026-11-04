/**
 * Phone number normalization, shared by registration and login so both
 * always produce the same stored value.
 *
 * Output format matches the users_phone_format_check constraint in schema.sql:
 * international format with a leading "+", e.g. +252610000001.
 */

// Same rule as users_phone_format_check: "+", then 8–15 digits, not starting with 0.
const PHONE_REGEX = /^\+[1-9][0-9]{7,14}$/;

/**
 * Removes formatting characters and converts a "00" international prefix to "+".
 *   "+252 61 000-0001"  -> "+252610000001"
 *   "00252610000001"    -> "+252610000001"
 * Local numbers without a country code (e.g. "0610000001") are left as they
 * are and will fail PHONE_REGEX, because the country cannot be known for sure.
 * @param {string} value
 * @returns {string}
 */
function normalizePhone(value) {
  const compact = String(value).trim().replace(/[\s\-.()]/g, '');
  return compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
}

module.exports = { normalizePhone, PHONE_REGEX };
