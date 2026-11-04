/**
 * Local photo storage. Files go to a temporary folder (UPLOADS_DIR is set in
 * tests/setup.js), never to backend/uploads.
 */
const fs = require('fs');
const path = require('path');
const { env } = require('../src/config/env');
const storage = require('../src/storage/photoStorage');
const { IMAGES } = require('./helpers');

const JPEG_TYPE = { mimeType: 'image/jpeg', extension: 'jpg' };
const PNG_TYPE = { mimeType: 'image/png', extension: 'png' };
const fileOnDisk = (storagePath) => path.join(env.uploadsDir, storagePath);

afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

describe('photoStorage', () => {
  test('uses a temporary test folder, not backend/uploads', () => {
    expect(env.uploadsDir).toContain('city-issue-test-uploads-');
  });

  test('savePhoto writes the bytes under a random UUID name and returns its details', async () => {
    const saved = await storage.savePhoto(IMAGES.jpeg, JPEG_TYPE);

    expect(saved.storagePath).toMatch(/^issues\/[0-9a-f-]{36}\.jpg$/);
    expect(saved).toMatchObject({
      mimeType: 'image/jpeg',
      sizeBytes: IMAGES.jpeg.length,
      url: `/uploads/${saved.storagePath}`,
    });
    expect(fs.readFileSync(fileOnDisk(saved.storagePath)).equals(IMAGES.jpeg)).toBe(true);
  });

  test('two saves never share a name', async () => {
    const a = await storage.savePhoto(IMAGES.png, PNG_TYPE);
    const b = await storage.savePhoto(IMAGES.png, PNG_TYPE);

    expect(a.storagePath).not.toBe(b.storagePath);
  });

  test('savePhoto refuses empty files and unknown types', async () => {
    await expect(storage.savePhoto(Buffer.alloc(0), JPEG_TYPE)).rejects.toThrow();
    await expect(storage.savePhoto(IMAGES.gif, { mimeType: 'image/gif', extension: 'gif' })).rejects.toThrow();
  });
});

describe('savePhoto() checks the bytes itself (does not trust the caller)', () => {
  const issuesDir = path.join(env.uploadsDir, 'issues');
  const countFiles = () => (fs.existsSync(issuesDir) ? fs.readdirSync(issuesDir).length : 0);

  test('derives type and extension from the bytes when no type is given', async () => {
    const saved = await storage.savePhoto(IMAGES.webp);

    expect(saved.storagePath).toMatch(/\.webp$/);
    expect(saved.mimeType).toBe('image/webp');
  });

  test.each([
    ['plain text', IMAGES.text],
    ['GIF', IMAGES.gif],
    ['WAV audio', IMAGES.wav],
  ])('415 for %s even when the caller claims it is a JPEG; nothing written', async (_label, bytes) => {
    const before = countFiles();

    await expect(storage.savePhoto(bytes, JPEG_TYPE)).rejects.toMatchObject({
      statusCode: 415,
      code: 'UNSUPPORTED_IMAGE_TYPE',
    });
    expect(countFiles()).toBe(before);
  });

  test.each([
    ['PNG bytes labelled as JPEG', IMAGES.png, JPEG_TYPE],
    ['JPEG bytes labelled as PNG', IMAGES.jpeg, PNG_TYPE],
    ['JPEG bytes with a PNG MIME but jpg extension', IMAGES.jpeg, { mimeType: 'image/png', extension: 'jpg' }],
    ['JPEG bytes with a dangerous extension', IMAGES.jpeg, { mimeType: 'image/jpeg', extension: 'html' }],
  ])('refuses a mismatched type (%s); nothing written', async (_label, bytes, claimed) => {
    const before = countFiles();

    await expect(storage.savePhoto(bytes, claimed)).rejects.toThrow('Photo type does not match its content');
    expect(countFiles()).toBe(before);
  });

  test('413 for a photo over 5 MB; nothing written', async () => {
    const tooBig = Buffer.concat([IMAGES.jpeg, Buffer.alloc(storage.MAX_PHOTO_BYTES)]);
    const before = countFiles();

    await expect(storage.savePhoto(tooBig)).rejects.toMatchObject({
      statusCode: 413,
      code: 'PHOTO_TOO_LARGE',
    });
    expect(countFiles()).toBe(before);
  });

  test('accepts a photo of exactly 5 MB', async () => {
    const exact = Buffer.concat([IMAGES.jpeg, Buffer.alloc(storage.MAX_PHOTO_BYTES - IMAGES.jpeg.length)]);

    const saved = await storage.savePhoto(exact, JPEG_TYPE);

    expect(saved.sizeBytes).toBe(storage.MAX_PHOTO_BYTES);
    await storage.deletePhoto(saved.storagePath);
  });
});

describe('photoStorage — delete, path checks and cleanup', () => {

  test('deletePhoto removes the file, and deleting a missing file is not an error', async () => {
    const saved = await storage.savePhoto(IMAGES.jpeg, JPEG_TYPE);

    await storage.deletePhoto(saved.storagePath);
    expect(fs.existsSync(fileOnDisk(saved.storagePath))).toBe(false);
    await expect(storage.deletePhoto(saved.storagePath)).resolves.toBeUndefined();
  });

  test.each([
    '../../.env',
    'issues/../../.env',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'issues/not-a-uuid.jpg',
    'issues/3f2b8c1e-0d4a-4b7e-9c1a-2b3c4d5e6f70.exe',
    'other/3f2b8c1e-0d4a-4b7e-9c1a-2b3c4d5e6f70.jpg',
  ])('rejects arbitrary path %p for delete and URL', async (badPath) => {
    expect(storage.isValidStoragePath(badPath)).toBe(false);
    await expect(storage.deletePhoto(badPath)).rejects.toThrow('Invalid photo storage path');
    expect(() => storage.getPhotoUrl(badPath)).toThrow('Invalid photo storage path');
  });

  test('withStoredPhotos passes saved photos to work and keeps them on success', async () => {
    const files = [
      { buffer: IMAGES.jpeg, imageType: JPEG_TYPE },
      { buffer: IMAGES.png, imageType: PNG_TYPE },
    ];

    const result = await storage.withStoredPhotos(files, async (photos) => photos);

    expect(result).toHaveLength(2);
    for (const photo of result) expect(fs.existsSync(fileOnDisk(photo.storagePath))).toBe(true);
  });

  test('withStoredPhotos deletes every saved photo when work fails (e.g. transaction rollback)', async () => {
    let savedPaths = [];
    const failure = new Error('transaction rolled back');

    await expect(
      storage.withStoredPhotos(
        [
          { buffer: IMAGES.jpeg, imageType: JPEG_TYPE },
          { buffer: IMAGES.png, imageType: PNG_TYPE },
        ],
        async (photos) => {
          savedPaths = photos.map((p) => p.storagePath);
          throw failure;
        }
      )
    ).rejects.toBe(failure);

    expect(savedPaths).toHaveLength(2);
    for (const p of savedPaths) expect(fs.existsSync(fileOnDisk(p))).toBe(false);
  });

  test('withStoredPhotos removes already-saved photos when a later save fails', async () => {
    const before = fs.readdirSync(path.join(env.uploadsDir, 'issues')).length;
    const work = jest.fn();

    await expect(
      storage.withStoredPhotos(
        [
          { buffer: IMAGES.jpeg, imageType: JPEG_TYPE },
          { buffer: Buffer.alloc(0), imageType: JPEG_TYPE }, // second save fails
        ],
        work
      )
    ).rejects.toThrow('Photo is empty');

    expect(work).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(env.uploadsDir, 'issues'))).toHaveLength(before);
  });
});
