/**
 * The single HTTP client. Adds the Bearer token, and turns every failure into
 * an ApiError with the backend's stable error code
 * ({ error: { code, message, details } }), so pages translate by code.
 */
import axios from 'axios';
import { API_BASE_URL, TOKEN_STORAGE_KEY } from '../config';

export class ApiError extends Error {
  constructor({ status = 0, code = 'NETWORK_ERROR', message = 'Network error', details = null }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Token storage (the JWT only; user data is always re-read from /auth/me). */
export const tokenStore = {
  get() {
    try {
      return localStorage.getItem(TOKEN_STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set(token) {
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } catch {
      // storage unavailable (private mode): the session lasts until reload
    }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // ignore
    }
  },
};

const client = axios.create({ baseURL: API_BASE_URL, timeout: 30000 });

client.interceptors.request.use((config) => {
  const token = tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/** Called when the server says the session is no longer valid. */
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

const SESSION_CODES = new Set(['INVALID_TOKEN', 'TOKEN_EXPIRED', 'AUTH_REQUIRED']);

client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      const { status, data } = error.response;
      const body = data && data.error ? data.error : {};
      const apiError = new ApiError({
        status,
        code: body.code || `HTTP_${status}`,
        message: body.message || error.message,
        details: body.details ?? null,
      });
      if (status === 401 && SESSION_CODES.has(apiError.code) && tokenStore.get()) onUnauthorized(apiError);
      return Promise.reject(apiError);
    }
    const code = error.code === 'ECONNABORTED' ? 'TIMEOUT' : 'NETWORK_ERROR';
    return Promise.reject(new ApiError({ code, message: error.message }));
  }
);

export default client;
