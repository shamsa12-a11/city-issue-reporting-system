const { hashPassword, verifyPassword } = require('../src/utils/password');
const { DEMO_PASSWORD, DEMO_HASH_2A } = require('./helpers');

describe('password hashing (bcrypt)', () => {
  test('verifies a pgcrypto-style $2a$ hash like the seed data uses', async () => {
    expect(DEMO_HASH_2A.startsWith('$2a$')).toBe(true);
    await expect(verifyPassword(DEMO_PASSWORD, DEMO_HASH_2A)).resolves.toBe(true);
  });

  test('rejects a wrong password', async () => {
    await expect(verifyPassword('WrongPassword#1', DEMO_HASH_2A)).resolves.toBe(false);
  });

  test('hashPassword produces a bcrypt hash (not plain text) that verifies', async () => {
    const hash = await hashPassword('Another#Pass1');

    expect(hash).toMatch(/^\$2[ab]\$10\$/);
    expect(hash).not.toContain('Another#Pass1');
    await expect(verifyPassword('Another#Pass1', hash)).resolves.toBe(true);
  });

  test('returns false (never throws) for missing or malformed input', async () => {
    await expect(verifyPassword(undefined, DEMO_HASH_2A)).resolves.toBe(false);
    await expect(verifyPassword(DEMO_PASSWORD, null)).resolves.toBe(false);
    await expect(verifyPassword(DEMO_PASSWORD, 'not-a-bcrypt-hash')).resolves.toBe(false);
  });
});
