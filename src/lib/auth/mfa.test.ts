import { randomBytes } from 'node:crypto';
import { generate, generateSecret } from 'otplib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock('@/lib/db/prisma', () => ({ getAuthPrisma: vi.fn() }));
import { checkMfa, decryptMfaSecret, encryptMfaSecret } from './mfa';
import { hashToken } from './csrf';
beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_MFA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
});
describe('MFA factor protection', () => {
  it('encrypts TOTP secrets with authenticated independent nonces and rejects tampering', () => {
    const secret = generateSecret();
    const first = encryptMfaSecret(secret),
      second = encryptMfaSecret(secret);
    expect(first).not.toContain(secret);
    expect(first).not.toBe(second);
    expect(decryptMfaSecret(first)).toBe(secret);
    const parts = first.split(':');
    parts[1] = `${parts[1].startsWith('a') ? 'b' : 'a'}${parts[1].slice(1)}`;
    expect(() => decryptMfaSecret(parts.join(':'))).toThrow();
  });
  it('rejects reused TOTP time steps', async () => {
    const secret = generateSecret(),
      step = Math.floor(Date.now() / 30000);
    const factor = {
      id: '00000000-0000-4000-8000-000000000001',
      secret_encrypted: encryptMfaSecret(secret),
      verified_at: new Date(),
      recovery_hashes: [],
      last_used_step: BigInt(step),
    };
    mocks.query.mockResolvedValue([factor]);
    await expect(
      checkMfa(
        { $queryRaw: mocks.query, $executeRaw: mocks.execute } as never,
        'user',
        await generate({ secret })
      )
    ).rejects.toThrow('already used');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('matches recovery hashes and atomically removes the consumed digest', async () => {
    const code = 'ABCDEF0123456789ABCDE';
    mocks.query.mockResolvedValue([
      {
        id: 'id',
        secret_encrypted: '',
        verified_at: new Date(),
        last_used_step: null,
        recovery_hashes: [hashToken(code)],
      },
    ]);
    expect(
      await checkMfa(
        { $queryRaw: mocks.query, $executeRaw: mocks.execute } as never,
        'user',
        code.toLowerCase()
      )
    ).toBe(true);
    expect(mocks.execute.mock.calls[0][0].join('?')).toContain('array_remove');
    expect(mocks.execute.mock.calls[0]).toContain(hashToken(code));
    expect(mocks.execute.mock.calls[0]).not.toContain(code);
  });
});
