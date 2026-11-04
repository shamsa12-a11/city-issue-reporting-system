/**
 * Photo upload middleware (multipart/form-data, field name "photos").
 *
 *   router.post('/issues', authenticate, authorize(ROLES.CITIZEN),
 *               photoUpload({ min: 1, max: 3 }), rules, validate, controller.create);
 *
 * Steps:
 *  1. multer reads the form into memory (nothing is written to disk yet), with
 *     hard limits on file size, file count and form size.
 *  2. Every file's real type is detected from its bytes. The client's file
 *     name and Content-Type are ignored.
 *  3. Verified files are left on req.files as { buffer, size, imageType }.
 *     Saving to storage happens later (storage/photoStorage.withStoredPhotos),
 *     only after all validation has passed.
 *
 * Errors (all as { error: { code, message } }):
 *   400 PHOTOS_REQUIRED, TOO_MANY_PHOTOS, UNEXPECTED_FILE_FIELD, INVALID_UPLOAD
 *   413 PHOTO_TOO_LARGE
 *   415 UNSUPPORTED_IMAGE_TYPE
 */
const multer = require('multer');
const AppError = require('../utils/AppError');
const { detectImageType } = require('../utils/imageType');
// One shared limit: storage enforces the same 5 MB again when saving.
const { MAX_PHOTO_BYTES } = require('../storage/photoStorage');

const PHOTO_FIELD = 'photos';
const MAX_PHOTOS = 3; // Feature 1: 1–3 photos per report

const multerLimits = {
  fileSize: MAX_PHOTO_BYTES,
  files: MAX_PHOTOS,
  fields: 20, // text fields (category, description, coordinates, ...)
  fieldSize: 10 * 1024, // 10 KB per text field
  parts: MAX_PHOTOS + 20,
};

/** Converts multer / form-parsing errors into safe, client-facing AppErrors. */
function toUploadError(err) {
  if (err instanceof multer.MulterError) {
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        return new AppError(413, 'PHOTO_TOO_LARGE', `Each photo must be ${MAX_PHOTO_BYTES / 1024 / 1024} MB or smaller`);
      case 'LIMIT_FILE_COUNT':
        return new AppError(400, 'TOO_MANY_PHOTOS', `You can upload at most ${MAX_PHOTOS} photos`);
      case 'LIMIT_UNEXPECTED_FILE':
        // Same code for "too many files in the photos field" and "a file in another field".
        return err.field === PHOTO_FIELD
          ? new AppError(400, 'TOO_MANY_PHOTOS', `You can upload at most ${MAX_PHOTOS} photos`)
          : new AppError(400, 'UNEXPECTED_FILE_FIELD', `Photos must be sent in the "${PHOTO_FIELD}" field`);
      default:
        return new AppError(400, 'INVALID_UPLOAD', 'The upload form is invalid or too large');
    }
  }
  // Malformed multipart bodies (bad boundary, truncated upload, ...) come from
  // the form parser as plain errors. Their text is not shown to the client.
  return new AppError(400, 'INVALID_UPLOAD', 'The upload form is invalid or incomplete');
}

/**
 * Builds the upload middleware chain.
 * @param {object} [options]
 * @param {number} [options.min=1] minimum photos required (0 = optional)
 * @param {number} [options.max=3] maximum photos allowed (at most MAX_PHOTOS)
 * @returns {import('express').RequestHandler[]}
 */
function photoUpload({ min = 1, max = MAX_PHOTOS } = {}) {
  if (!(max >= 1 && max <= MAX_PHOTOS) || !(min >= 0 && min <= max)) {
    throw new Error(`photoUpload(): invalid min/max (${min}/${max})`);
  }

  const parse = multer({
    storage: multer.memoryStorage(),
    limits: { ...multerLimits, files: max },
  }).array(PHOTO_FIELD, max);

  const parseSafely = (req, res, next) =>
    parse(req, res, (err) => next(err ? toUploadError(err) : undefined));

  const verify = (req, _res, next) => {
    const files = Array.isArray(req.files) ? req.files : [];

    if (files.length < min) {
      return next(
        new AppError(
          400,
          'PHOTOS_REQUIRED',
          min === 1 ? 'At least one photo is required' : `At least ${min} photos are required`
        )
      );
    }

    for (const file of files) {
      const imageType = detectImageType(file.buffer);
      if (!imageType) {
        return next(
          new AppError(415, 'UNSUPPORTED_IMAGE_TYPE', 'Photos must be JPEG, PNG or WebP images')
        );
      }
      // Keep only what later code needs; drop the client's name and MIME type.
      file.imageType = imageType;
      delete file.originalname;
      delete file.mimetype;
    }
    req.files = files;
    return next();
  };

  return [parseSafely, verify];
}

module.exports = { photoUpload, MAX_PHOTOS, MAX_PHOTO_BYTES, PHOTO_FIELD };
