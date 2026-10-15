import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';
describe('password storage', () => {
  it('uses Argon2id, salts hashes independently and verifies the actual password', async () => {
    const password = 'long-test-passphrase-42';
    const first = await hashPassword(password),
      second = await hashPassword(password);
    expect(first).toMatch(/^\$argon2id\$/);
    expect(first).not.toBe(second);
    expect(await verifyPassword(first, password)).toBe(true);
    expect(await verifyPassword(first, 'incorrect-password')).toBe(false);
  });
  it('rejects passwords shorter than 12 and oversized inputs', async () => {
    await expect(hashPassword('short')).rejects.toThrow();
    await expect(hashPassword('a'.repeat(1025))).rejects.toThrow();
  });
});
