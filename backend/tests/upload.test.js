/**
 * Photo upload middleware and /uploads static serving.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const fs = require('fs');
const express = require('express');
const request = require('supertest');
const app = require('../src/app');
const { env } = require('../src/config/env');
const { photoUpload, MAX_PHOTO_BYTES } = require('../src/middleware/upload');
const { errorHandler } = require('../src/middleware/errorHandler');
const { savePhoto } = require('../src/storage/photoStorage');
const { IMAGES } = require('./helpers');

afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

// Small app using the middleware exactly as an issue route will.
const describeFiles = (req, res) =>
  res.json({
    count: req.files.length,
    files: req.files.map((f) => ({
      size: f.size,
      imageType: f.imageType,
      originalname: f.originalname,
      mimetype: f.mimetype,
    })),
    body: req.body,
  });
const testApp = express();
testApp.post('/upload', photoUpload(), describeFiles);
testApp.post('/upload-optional', photoUpload({ min: 0, max: 1 }), describeFiles);
testApp.use(errorHandler);

const post = (path = '/upload') => request(testApp).post(path);
const jpeg = { filename: 'photo.jpg', contentType: 'image/jpeg' };

describe('photoUpload() middleware', () => {
  test('accepts one JPEG with text fields, detects the type from bytes, drops client name/MIME', async () => {
    const res = await post()
      .field('description', 'Large pothole near the market')
      .attach('photos', IMAGES.jpeg, jpeg);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.files[0]).toEqual({
      size: IMAGES.jpeg.length,
      imageType: { mimeType: 'image/jpeg', extension: 'jpg' },
    });
    expect(res.body.body.description).toBe('Large pothole near the market');
  });

  test('accepts up to 3 photos of mixed allowed formats', async () => {
    const res = await post()
      .attach('photos', IMAGES.jpeg, jpeg)
      .attach('photos', IMAGES.png, { filename: 'b.png', contentType: 'image/png' })
      .attach('photos', IMAGES.webp, { filename: 'c.webp', contentType: 'image/webp' });

    expect(res.status).toBe(200);
    expect(res.body.files.map((f) => f.imageType.extension)).toEqual(['jpg', 'png', 'webp']);
  });

  test('400 PHOTOS_REQUIRED when no photo is sent', async () => {
    const res = await post().field('description', 'No photo attached here');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PHOTOS_REQUIRED');
  });

  test('400 PHOTOS_REQUIRED for a JSON request (not multipart)', async () => {
    const res = await post().send({ description: 'JSON instead of a form' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PHOTOS_REQUIRED');
  });

  test('400 TOO_MANY_PHOTOS for a 4th photo', async () => {
    let req = post();
    for (let i = 0; i < 4; i += 1) req = req.attach('photos', IMAGES.jpeg, jpeg);
    const res = await req;

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOO_MANY_PHOTOS');
  });

  test('413 PHOTO_TOO_LARGE for a photo over 5 MB', async () => {
    const big = Buffer.concat([IMAGES.jpeg, Buffer.alloc(MAX_PHOTO_BYTES)]);

    const res = await post().attach('photos', big, jpeg);

    expect(res.status).toBe(413);
    expect(res.body.error).toEqual({
      code: 'PHOTO_TOO_LARGE',
      message: 'Each photo must be 5 MB or smaller',
    });
  });

  test('415 for a text file disguised with a .jpg name and image/jpeg type', async () => {
    const res = await post().attach('photos', IMAGES.text, jpeg);

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_IMAGE_TYPE');
  });

  test('415 when any one of several photos is not an allowed image (GIF)', async () => {
    const res = await post()
      .attach('photos', IMAGES.jpeg, jpeg)
      .attach('photos', IMAGES.gif, { filename: 'x.gif', contentType: 'image/gif' });

    expect(res.status).toBe(415);
  });

  test('400 UNEXPECTED_FILE_FIELD for a file in another field', async () => {
    const res = await post().attach('avatar', IMAGES.jpeg, jpeg);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNEXPECTED_FILE_FIELD');
  });

  test('400 INVALID_UPLOAD for a broken multipart body, without parser details', async () => {
    const res = await post()
      .set('Content-Type', 'multipart/form-data; boundary=XYZ')
      .send('--XYZ\r\nContent-Disposition: form-data; name="photos"; filename="a.jpg"\r\n\r\n\xff\xd8\xff');

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: 'INVALID_UPLOAD',
      message: 'The upload form is invalid or incomplete',
    });
  });

  test('min: 0 makes photos optional, max: 1 limits to one', async () => {
    expect((await post('/upload-optional').field('note', 'x')).body.count).toBe(0);

    const two = await post('/upload-optional')
      .attach('photos', IMAGES.jpeg, jpeg)
      .attach('photos', IMAGES.jpeg, jpeg);
    expect(two.status).toBe(400);
    expect(two.body.error.code).toBe('TOO_MANY_PHOTOS');
  });

  test('rejects invalid min/max configuration when the route is defined', () => {
    expect(() => photoUpload({ max: 4 })).toThrow();
    expect(() => photoUpload({ min: 2, max: 1 })).toThrow();
  });

  test('nothing is written to the uploads folder by the middleware itself', async () => {
    const dirBefore = fs.existsSync(env.uploadsDir) ? fs.readdirSync(env.uploadsDir, { recursive: true }) : [];

    await post().attach('photos', IMAGES.jpeg, jpeg);

    const dirAfter = fs.existsSync(env.uploadsDir) ? fs.readdirSync(env.uploadsDir, { recursive: true }) : [];
    expect(dirAfter).toEqual(dirBefore);
  });
});

describe('GET /uploads/... (static photo serving)', () => {
  test('serves a stored photo with the right type and a cross-origin resource policy', async () => {
    const saved = await savePhoto(IMAGES.png, { mimeType: 'image/png', extension: 'png' });

    const res = await request(app).get(saved.url);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(res.body).equals(IMAGES.png)).toBe(true);
  });

  test('API responses keep the strict same-origin policy', async () => {
    const res = await request(app).get('/api/health');

    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  test.each([
    '/uploads/issues/3f2b8c1e-0d4a-4b7e-9c1a-2b3c4d5e6f70.jpg', // valid name, no file
    '/uploads/issues/not-a-uuid.jpg',
    '/uploads/%2e%2e/%2e%2e/.env',
    '/uploads/..%2f..%2fpackage.json',
    '/uploads/',
  ])('returns a JSON 404 for %s', async (url) => {
    const res = await request(app).get(url);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
