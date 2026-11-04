/**
 * Detects the real image type from a file's first bytes ("magic numbers").
 *
 * The file name and the Content-Type sent by the client are never trusted:
 * a text file renamed to photo.jpg is rejected here. Only the three formats
 * allowed by photos.mime_type in schema.sql are accepted.
 */

const SIGNATURES = [
  {
    mimeType: 'image/jpeg',
    extension: 'jpg',
    // FF D8 FF = JPEG start-of-image marker followed by the next marker.
    matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mimeType: 'image/png',
    extension: 'png',
    // 89 "PNG" CR LF 1A LF — the fixed 8-byte PNG signature.
    matches: (b) =>
      b.length >= 8 &&
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mimeType: 'image/webp',
    extension: 'webp',
    // "RIFF" <4-byte size> "WEBP". Checking "WEBP" rules out other RIFF files (e.g. WAV audio).
    matches: (b) =>
      b.length >= 12 &&
      b.toString('latin1', 0, 4) === 'RIFF' &&
      b.toString('latin1', 8, 12) === 'WEBP',
  },
];

/** MIME types accepted for photos (same list as the photos_mime_type check). */
const ALLOWED_IMAGE_MIME_TYPES = SIGNATURES.map((s) => s.mimeType);

/**
 * @param {Buffer} buffer file contents
 * @returns {{ mimeType: string, extension: string } | null} null if not an allowed image
 */
function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  const match = SIGNATURES.find((sig) => sig.matches(buffer));
  return match ? { mimeType: match.mimeType, extension: match.extension } : null;
}

module.exports = { detectImageType, ALLOWED_IMAGE_MIME_TYPES };
