import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  sign: vi.fn(),
}));
vi.mock('@/lib/db/prisma', () => ({
  getAuthPrisma: () => ({ $transaction: mocks.transaction }),
}));
vi.mock('./jwt', () => ({ signAccessToken: mocks.sign }));
vi.mock('./mfa', () => ({ checkMfa: vi.fn() }));
import { rotateRefreshToken } from './service';
import { hashToken } from './csrf';
const token = 'a'.repeat(43),
  csrf = 'b'.repeat(43);
const row = {
  id: '00000000-0000-4000-8000-000000000001',
  session_id: '00000000-0000-4000-8000-000000000002',
  user_id: '00000000-0000-4000-8000-000000000003',
  account_id: '00000000-0000-4000-8000-000000000004',
  consumed_at: null,
  expires_at: new Date(Date.now() + 60000),
  session_expires_at: new Date(Date.now() + 120000),
  csrf_hash: hashToken(csrf),
  revoked_at: null,
};
const request = () =>
  new Request('https://crm.test/api/auth/refresh', {
    method: 'POST',
    headers: { origin: 'https://crm.test', 'x-csrf-token': csrf },
  });
beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_URL = 'https://crm.test';
  mocks.transaction.mockImplementation(async (operation) =>
    operation({ $queryRaw: mocks.query, $executeRaw: mocks.execute })
  );
  mocks.sign.mockResolvedValue('signed-access');
  mocks.execute.mockResolvedValue(1);
});
describe('refresh session families', () => {
  it('commits family revocation before reporting reused token failure', async () => {
    mocks.query.mockResolvedValueOnce([{ ...row, consumed_at: new Date() }]);
    let committed = false;
    mocks.transaction.mockImplementation(async (operation) => {
      const result = await operation({
        $queryRaw: mocks.query,
        $executeRaw: mocks.execute,
      });
      committed = true;
      return result;
    });
    await expect(rotateRefreshToken(token, request())).rejects.toThrow(
      'Session expired'
    );
    expect(committed).toBe(true);
    expect(mocks.execute.mock.calls[0][0].join('?')).toContain(
      'UPDATE auth_sessions SET revoked_at'
    );
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it('does not extend the seven-day session deadline during rotation', async () => {
    mocks.query
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([{ id: row.user_id }]);
    const result = await rotateRefreshToken(token, request());
    expect(result.expiresAt).toEqual(row.session_expires_at);
    expect(result.refreshToken).not.toBe(token);
    expect(mocks.execute.mock.calls[0]).toContainEqual(row.session_expires_at);
    expect(mocks.execute.mock.calls[1][0].join('?')).toContain(
      'consumed_at=NOW()'
    );
  });
  it('cannot rotate with missing CSRF even if the refresh secret is known', async () => {
    mocks.query.mockResolvedValueOnce([row]);
    await expect(
      rotateRefreshToken(
        token,
        new Request('https://crm.test', {
          headers: { origin: 'https://crm.test' },
        })
      )
    ).rejects.toThrow('CSRF');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('refuses revoked, expired and deleted memberships', async () => {
    for (const variant of ['revoked', 'expired', 'membership']) {
      mocks.query.mockResolvedValueOnce([
        {
          ...row,
          revoked_at: variant === 'revoked' ? new Date() : null,
          expires_at: variant === 'expired' ? new Date(0) : row.expires_at,
        },
      ]);
      if (variant === 'membership') mocks.query.mockResolvedValueOnce([]);
      await expect(rotateRefreshToken(token, request())).rejects.toThrow();
    }
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
