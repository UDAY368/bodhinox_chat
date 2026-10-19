import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, validatePassword } from './password';
import { hash } from 'argon2';
describe('password storage', () => {
  it('continues verifying existing passwords that predate the new creation rules', async () => {
    const legacy = 'existing-lowercase-password-42';
    expect(await verifyPassword(await hash(legacy), legacy)).toBe(true);
  });
  it('uses Argon2id, salts hashes independently and verifies the actual password', async () => {
    const password = 'Long-test-passphrase-42';
    const first = await hashPassword(password),
      second = await hashPassword(password);
    expect(first).toMatch(/^\$argon2id\$/);
    expect(first).not.toBe(second);
    expect(await verifyPassword(first, password)).toBe(true);
    expect(await verifyPassword(first, 'incorrect-password')).toBe(false);
  });
  it('accepts eight characters with an uppercase letter, number, and special character', () => {
    expect(() => validatePassword('Abcdef1!')).not.toThrow();
  });
  it.each(['abcdef1!', 'Abcdefg!', 'Abcdef12', 'Abcd1!x', 'Abcdef1 ', 'Abcdef1é', 'long-test-password-42', 'Longtestpassword42', 'Long-test-password'])('rejects incomplete password rules: %s', (value) => {
    expect(() => validatePassword(value)).toThrow();
  });
  it('rejects short and oversized inputs', async () => {
    await expect(hashPassword('short')).rejects.toThrow();
    await expect(hashPassword('a'.repeat(1025))).rejects.toThrow();
  });
});
