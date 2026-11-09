/**
 * Frontend configuration. In development Vite proxies /api and /uploads to
 * the backend (vite.config.js); a production build can point at another
 * origin with VITE_API_ORIGIN.
 */
const origin = (import.meta.env.VITE_API_ORIGIN || '').replace(/\/+$/, '');

export const API_BASE_URL = `${origin}/api`;

/** Photo URLs from the API are paths like "/uploads/issues/<uuid>.jpg". */
export const assetUrl = (path) => (path && path.startsWith('/') ? `${origin}${path}` : path);

/** Mogadishu, used to centre maps when no data or location is available. */
export const DEFAULT_MAP_CENTER = [2.046, 45.318];
export const DEFAULT_MAP_ZOOM = 12;

/** Limits that mirror the backend validation. */
export const LIMITS = Object.freeze({
  descriptionMin: 10,
  descriptionMax: 2000,
  photosMin: 1,
  photosMax: 3,
  photoMaxBytes: 5 * 1024 * 1024,
  photoTypes: ['image/jpeg', 'image/png', 'image/webp'],
  commentMin: 5,
  commentMax: 1000,
  passwordMin: 8,
});

export const TOKEN_STORAGE_KEY = 'codka.token';
export const LANGUAGE_STORAGE_KEY = 'codka.language';
