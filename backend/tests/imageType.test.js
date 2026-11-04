const { detectImageType } = require('../src/utils/imageType');
const { IMAGES } = require('./helpers');

describe('detectImageType() — real file bytes, not names or MIME headers', () => {
  test.each([
    ['jpeg', { mimeType: 'image/jpeg', extension: 'jpg' }],
    ['png', { mimeType: 'image/png', extension: 'png' }],
    ['webp', { mimeType: 'image/webp', extension: 'webp' }],
  ])('accepts %s', (name, expected) => {
    expect(detectImageType(IMAGES[name])).toEqual(expected);
  });

  test.each([
    ['GIF (not an allowed format)', IMAGES.gif],
    ['WAV audio (RIFF but not WEBP)', IMAGES.wav],
    ['plain text', IMAGES.text],
    ['an empty file', Buffer.alloc(0)],
    ['a truncated PNG signature', IMAGES.png.subarray(0, 5)],
    ['a non-buffer value', 'ffd8ff'],
  ])('rejects %s', (_label, input) => {
    expect(detectImageType(input)).toBeNull();
  });
});
