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
import { issueSession, rotateRefreshToken } from './service';
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
describe('shared session issuing', () => {
  const user = {
    id: row.user_id,
    password_hash: 'hash',
    disabled_at: null,
    email_verified_at: new Date(),
  };
  const sql = (call: unknown[]) => (call[0] as string[]).join('?');
  it('stores the device and sign-in method, audits only when asked, and returns the session id', async () => {
    mocks.query
      .mockResolvedValueOnce([user])
      .mockResolvedValueOnce([{ account_id: row.account_id }]);
    const issued = await issueSession(user.id, {
      method: 'password',
      userAgent: 'Agent\u0000/1',
      expectedPasswordHash: 'hash',
    });
    expect(issued.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const insert = mocks.execute.mock.calls.find((c) => sql(c).includes('INSERT INTO auth_sessions'))!;
    expect(insert).toContain('Agent/1');
    expect(insert).toContain('password');
    expect(insert).toContain(issued.sessionId);
    expect(mocks.execute.mock.calls.some((c) => sql(c).includes('audit_logs'))).toBe(false);
    mocks.query
      .mockResolvedValueOnce([user])
      .mockResolvedValueOnce([{ account_id: row.account_id }]);
    const google = await issueSession(user.id, { method: 'google', auditAction: 'auth.google_sign_in' });
    const audit = mocks.execute.mock.calls.find((c) => sql(c).includes('audit_logs'))!;
    expect(audit).toContain('auth.google_sign_in');
    expect(audit).toContain(google.sessionId);
  });
  it('refuses a changed password, a disabled user and a missing membership with the errors the caller picks', async () => {
    mocks.query.mockResolvedValueOnce([{ ...user, password_hash: 'changed' }]);
    await expect(
      issueSession(user.id, { method: 'password', expectedPasswordHash: 'hash' })
    ).rejects.toMatchObject({ code: 'unauthorized' });
    mocks.query.mockResolvedValueOnce([{ ...user, disabled_at: new Date() }]);
    await expect(
      issueSession(user.id, { method: 'google', refuseUser: () => new Error('custom user') })
    ).rejects.toThrow('custom user');
    mocks.query.mockResolvedValueOnce([user]).mockResolvedValueOnce([]);
    await expect(
      issueSession(user.id, {
        method: 'google',
        accountId: row.account_id,
        refuseWorkspace: () => new Error('custom workspace'),
      })
    ).rejects.toThrow('custom workspace');
    mocks.query.mockResolvedValueOnce([user]).mockResolvedValueOnce([{ account_id: row.account_id }]);
    await expect(
      issueSession(user.id, { method: 'password', accountId: row.session_id })
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('gives a verified identity with no membership left a personal workspace instead of refusing it', async () => {
    mocks.query.mockResolvedValueOnce([user]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ assigned: true }]);
    await issueSession(user.id, { method: 'password' });
    const owned = mocks.execute.mock.calls.find((c) => sql(c).includes('INSERT INTO accounts'))!;
    // The new workspace is given its initial plan (the lowest one while NEW_WORKSPACE_PLAN is unset), never left on enterprise.
    expect(mocks.query.mock.calls.some((c) => sql(c).includes('billing_assign_initial_plan'))).toBe(true);
    const session = mocks.execute.mock.calls.find((c) => sql(c).includes('INSERT INTO auth_sessions'))!;
    expect(owned).toContain(user.id);
    expect(session).toContain(owned[1]);
    expect(
      mocks.execute.mock.calls.some(
        (c) => sql(c).includes('INSERT INTO account_memberships') && sql(c).includes("'owner'")
      )
    ).toBe(true);
  });
});
