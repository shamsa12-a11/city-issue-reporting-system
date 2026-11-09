/** Client-side checks that mirror the backend rules (the backend re-checks). */

/** Same as backend utils/phone.js: strips spaces, dashes, dots, brackets; "00" -> "+". */
export function normalizePhone(value) {
  const compact = String(value || '').trim().replace(/[\s\-.()]/g, '');
  return compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
}

export const isPhone = (value) => /^\+[1-9][0-9]{7,14}$/.test(normalizePhone(value));
export const isSomaliMobile = (value) => /^\+252[1-9][0-9]{6,8}$/.test(normalizePhone(value));

/** Counts characters like PostgreSQL length() (code points). */
export const charLength = (value) => [...String(value || '')].length;

export const isName = (value) => {
  const v = String(value || '').trim();
  return charLength(v) >= 2 && charLength(v) <= 100 && /\p{L}/u.test(v);
};

/** Returns a dictionary key for the first problem, or null. */
export function passwordProblem(value) {
  const v = String(value || '');
  if (v.length < 8) return 'validation.passwordLength';
  if (!/\p{L}/u.test(v) || !/\d/.test(v)) return 'validation.passwordLetterNumber';
  return null;
}

/** Field errors from a backend VALIDATION_ERROR ({ details: [{ field, message }] }). */
export function serverFieldErrors(error) {
  if (!error || error.code !== 'VALIDATION_ERROR' || !Array.isArray(error.details)) return {};
  return Object.fromEntries(error.details.filter((d) => d.field).map((d) => [d.field, d.message]));
}
