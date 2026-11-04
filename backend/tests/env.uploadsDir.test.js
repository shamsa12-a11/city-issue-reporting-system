/**
 * UPLOADS_DIR resolution and the filesystem-root startup check.
 */
const os = require('os');
const path = require('path');
const { resolveUploadsDir, isFilesystemRoot, BACKEND_DIR } = require('../src/config/env');

// The root of whatever drive/filesystem the tests run on: "C:\" or "/".
const FS_ROOT = path.parse(process.cwd()).root;

/** Loads a fresh copy of env.js / photoStorage.js with the given UPLOADS_DIR. */
function loadWithUploadsDir(value, moduleName = '../src/config/env') {
  const previous = process.env.UPLOADS_DIR;
  process.env.UPLOADS_DIR = value;
  try {
    let mod;
    jest.isolateModules(() => {
      mod = require(moduleName);
    });
    return mod;
  } finally {
    process.env.UPLOADS_DIR = previous;
  }
}

describe('resolveUploadsDir()', () => {
  test('BACKEND_DIR is the backend folder', () => {
    expect(path.basename(BACKEND_DIR)).toBe('backend');
    expect(require('fs').existsSync(path.join(BACKEND_DIR, 'package.json'))).toBe(true);
  });

  test.each([undefined, '', '   '])('defaults to backend/uploads when UPLOADS_DIR is %p', (value) => {
    expect(resolveUploadsDir(value)).toBe(path.join(BACKEND_DIR, 'uploads'));
  });

  test('resolves a relative value from the backend folder', () => {
    expect(resolveUploadsDir('photos')).toBe(path.join(BACKEND_DIR, 'photos'));
    expect(resolveUploadsDir('./data/uploads')).toBe(path.join(BACKEND_DIR, 'data', 'uploads'));
  });

  test('relative values do not depend on the current working directory', () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(os.tmpdir());
      expect(resolveUploadsDir('photos')).toBe(path.join(BACKEND_DIR, 'photos'));
      expect(resolveUploadsDir(undefined)).toBe(path.join(BACKEND_DIR, 'uploads'));
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('uses an absolute value as given', () => {
    const absolute = path.join(os.tmpdir(), 'city-issue-photos');

    expect(resolveUploadsDir(absolute)).toBe(absolute);
  });
});

describe('isFilesystemRoot()', () => {
  test.each([FS_ROOT, path.resolve('/')])('true for the root %p', (dir) => {
    expect(isFilesystemRoot(dir)).toBe(true);
  });

  test.each([path.join(BACKEND_DIR, 'uploads'), path.join(FS_ROOT, 'uploads'), os.tmpdir()])(
    'false for the folder %p',
    (dir) => {
      expect(isFilesystemRoot(dir)).toBe(false);
    }
  );
});

describe('startup check: assertRequiredEnv()', () => {
  test('passes with the default uploads folder', () => {
    const { assertRequiredEnv, env } = loadWithUploadsDir('');

    expect(env.uploadsDir).toBe(path.join(BACKEND_DIR, 'uploads'));
    expect(() => assertRequiredEnv()).not.toThrow();
  });

  // The last case is a relative path that climbs from backend/ up to the root.
  test.each([FS_ROOT, '/', path.relative(BACKEND_DIR, FS_ROOT)])(
    'rejects a filesystem root (UPLOADS_DIR=%p) with a clear message',
    (value) => {
      const { assertRequiredEnv } = loadWithUploadsDir(value);

      expect(() => assertRequiredEnv()).toThrow(
        /UPLOADS_DIR must be a dedicated folder, not a filesystem root/
      );
    }
  );

  test('photo storage refuses to write when the uploads folder is a root, even without the startup check', async () => {
    const storage = loadWithUploadsDir(FS_ROOT, '../src/storage/photoStorage');
    const { IMAGES } = require('./helpers');

    await expect(storage.savePhoto(IMAGES.jpeg)).rejects.toThrow(
      'Uploads folder must not be a filesystem root'
    );
  });
});
