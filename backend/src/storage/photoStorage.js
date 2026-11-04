/**
 * Photo storage — local disk implementation (backend/uploads/).
 *
 * This module is the only code that touches photo files. To move to Supabase
 * Storage later, replace this file with one that exports the same functions:
 *
 *   savePhoto(buffer, expectedType?)  -> { storagePath, mimeType, sizeBytes, url }
 *   deletePhoto(storagePath)          -> removes the file (no error if missing)
 *   getPhotoUrl(storagePath)          -> URL the frontend can load
 *   isValidStoragePath(storagePath)   -> true only for paths this module creates
 *   withStoredPhotos(files, work)     -> saves files, runs work, cleans up on failure
 *
 * Security:
 *   - File names are random UUIDs chosen here. The client's file name is never
 *     used, so it cannot contain "../" or overwrite anything.
 *   - Every path that comes back in (delete, URL) must match STORAGE_PATH_REGEX,
 *     and is then checked again to resolve inside the uploads folder.
 *   - savePhoto checks the file bytes itself (type and size). It does not
 *     rely on the upload middleware having done so.
 *   - photos.storage_path stores the relative key (e.g. "issues/<uuid>.jpg"),
 *     never an absolute disk path, so the database does not depend on the server.
 */
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { env, isFilesystemRoot } = require('../config/env');
const AppError = require('../utils/AppError');
const { detectImageType } = require('../utils/imageType');

const PHOTO_FOLDER = 'issues';
const PUBLIC_URL_PREFIX = '/uploads';

/** Largest photo accepted (5 MB). The upload middleware uses the same value. */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

// "issues/" + lowercase UUID v4 + one of our three extensions. Nothing else.
const STORAGE_PATH_REGEX =
  /^issues\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/;

/** True only for storage paths in the exact format this module creates. */
function isValidStoragePath(storagePath) {
  return typeof storagePath === 'string' && STORAGE_PATH_REGEX.test(storagePath);
}

/**
 * Converts a storage path to an absolute file path, refusing anything that is
 * not a valid storage path or that would land outside the uploads folder.
 * @throws {Error} for an invalid path
 */
function resolveFilePath(storagePath) {
  if (!isValidStoragePath(storagePath)) {
    throw new Error('Invalid photo storage path');
  }
  const root = env.uploadsDir;
  // Never read or write directly under a drive root, even if startup checks
  // were skipped (the server itself refuses to start with such a setting).
  if (isFilesystemRoot(root)) {
    throw new Error('Uploads folder must not be a filesystem root');
  }
  const fullPath = path.resolve(root, storagePath);
  // Defence in depth: the regex already blocks "..", but never trust one check.
  if (!fullPath.startsWith(root + path.sep)) {
    throw new Error('Invalid photo storage path');
  }
  return fullPath;
}

/**
 * Public URL for a stored photo, relative to the API server
 * (e.g. "/uploads/issues/<uuid>.jpg"). The frontend prefixes the API base URL.
 */
function getPhotoUrl(storagePath) {
  resolveFilePath(storagePath); // validates
  return `${PUBLIC_URL_PREFIX}/${storagePath}`;
}

/**
 * Saves one photo under a new random name.
 *
 * The type is always worked out from the bytes here; the caller's type is
 * never used to name or describe the file. If the caller passes an expected
 * type that disagrees with the bytes, that is a bug in the caller and the
 * save is refused.
 *
 * @param {Buffer} buffer file contents
 * @param {{ mimeType: string, extension: string }} [expectedType] optional, e.g. from the upload middleware
 * @returns {Promise<{ storagePath: string, mimeType: string, sizeBytes: number, url: string }>}
 * @throws {AppError} 400 INVALID_UPLOAD (empty), 413 PHOTO_TOO_LARGE, 415 UNSUPPORTED_IMAGE_TYPE
 * @throws {Error} if expectedType does not match the bytes (programming error -> 500)
 */
async function savePhoto(buffer, expectedType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AppError(400, 'INVALID_UPLOAD', 'Photo is empty');
  }
  if (buffer.length > MAX_PHOTO_BYTES) {
    throw new AppError(413, 'PHOTO_TOO_LARGE', 'Each photo must be 5 MB or smaller');
  }

  const imageType = detectImageType(buffer);
  if (!imageType) {
    throw new AppError(415, 'UNSUPPORTED_IMAGE_TYPE', 'Photos must be JPEG, PNG or WebP images');
  }
  if (
    expectedType &&
    (expectedType.mimeType !== imageType.mimeType || expectedType.extension !== imageType.extension)
  ) {
    throw new Error('Photo type does not match its content');
  }

  const storagePath = `${PHOTO_FOLDER}/${crypto.randomUUID()}.${imageType.extension}`;
  const fullPath = resolveFilePath(storagePath);

  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  // "wx" = fail if the file already exists, so nothing is ever overwritten.
  await fs.writeFile(fullPath, buffer, { flag: 'wx' });

  return {
    storagePath,
    mimeType: imageType.mimeType,
    sizeBytes: buffer.length,
    url: getPhotoUrl(storagePath),
  };
}

/**
 * Deletes a stored photo. A missing file is not an error (already cleaned up).
 * @throws {Error} for an invalid storage path
 */
async function deletePhoto(storagePath) {
  const fullPath = resolveFilePath(storagePath);
  try {
    await fs.unlink(fullPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/** Best-effort delete of several photos; logs failures instead of throwing. */
async function deletePhotosQuietly(storagePaths) {
  await Promise.all(
    storagePaths.map((p) =>
      deletePhoto(p).catch((err) => console.error('[storage] Could not delete photo:', err.message))
    )
  );
}

/**
 * Saves uploaded photos, then runs `work` with the saved photo details.
 * If saving any photo fails, or `work` throws (e.g. its database transaction
 * rolls back), every photo saved here is deleted and the error is re-thrown.
 * This keeps disk files and database rows in step.
 *
 *   await withStoredPhotos(req.files, (photos) =>
 *     withTransaction(async (client) => { ...insert rows using photos[i].storagePath... })
 *   );
 *
 * @param {Array<{ buffer: Buffer, imageType: object }>} files verified uploads
 * @param {(photos: Array<object>) => Promise<T>} work
 * @returns {Promise<T>}
 * @template T
 */
async function withStoredPhotos(files, work) {
  const saved = [];
  try {
    for (const file of files) {
      saved.push(await savePhoto(file.buffer, file.imageType));
    }
    return await work(saved);
  } catch (err) {
    await deletePhotosQuietly(saved.map((p) => p.storagePath));
    throw err;
  }
}

module.exports = {
  savePhoto,
  deletePhoto,
  getPhotoUrl,
  isValidStoragePath,
  withStoredPhotos,
  PUBLIC_URL_PREFIX,
  MAX_PHOTO_BYTES,
};
