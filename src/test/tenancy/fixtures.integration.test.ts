import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { requireSession, assertMutation } from '@/lib/auth/session';
import {
  apiKeyRequest, cleanupTenants, closeFixture, createTenantPair, fixtureDatabaseUrls, fixtureOwnerPool, signedRequest,
  type TenantPair,
} from './fixtures';

const databases = fixtureDatabaseUrls();

describe.skipIf(!databases)('[TEN-01] shared two-tenant fixture', () => {
  let pair: TenantPair;
  beforeAll(async () => { pair = await createTenantPair({ label: 'fixture' }); }, 60000);
  afterAll(async () => {
    if (pair) await cleanupTenants([pair.a.accountId, pair.b.accountId]);
    await closeFixture();
    await disconnectDatabases();
  }, 60000);

  it('creates two separate workspaces visible only to their own tenant through the app role', async () => {
    const { a, b } = pair;
    expect(a.accountId).not.toBe(b.accountId);
    const seen = await withTenant(a.context, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>('SELECT id::text FROM contacts WHERE id = ANY($1::uuid[])', [a.contactId, b.contactId]));
    expect(seen.map((row) => row.id)).toEqual([a.contactId]);
    const identity = await getPrisma().$queryRawUnsafe<{ role: string }[]>('SELECT current_user AS role');
    expect(identity[0].role).toBe('bodhinox_app');
  });

  it('signs browser-shaped requests that pass the real session, membership and CSRF checks', async () => {
    for (const role of ['owner', 'admin', 'agent', 'viewer'] as const) {
      const user = pair.a.users[role];
      const request = await signedRequest(user, 'POST', '/api/anything', { ok: true });
      const session = await requireSession(request);
      expect(session).toMatchObject({ accountId: pair.a.accountId, userId: user.userId, role });
      await expect(assertMutation(request, session)).resolves.toBeUndefined();
    }
    const user = pair.a.users.agent;
    const session = await requireSession(await signedRequest(user, 'GET', '/api/anything'));
    await expect(assertMutation(await signedRequest(user, 'POST', '/api/x', {}, { omitCsrf: true }), session)).rejects.toThrow();
    await expect(assertMutation(await signedRequest(user, 'POST', '/api/x', {}, { origin: 'https://evil.example' }), session)).rejects.toThrow();
  });

  it('builds API key requests and cleans up every row it made', async () => {
    const request = apiKeyRequest(pair.a.apiKey, 'GET', '/api/v1/me');
    expect(request.headers.get('authorization')).toBe(`Bearer ${pair.a.apiKey}`);
    const extra = await createTenantPair({ label: 'fixture-cleanup' });
    await cleanupTenants([extra.a.accountId, extra.b.accountId]);
    const left = await fixtureOwnerPool().query(
      'SELECT (SELECT count(*) FROM accounts WHERE id = ANY($1::uuid[]))::int AS accounts, (SELECT count(*) FROM auth_users WHERE id = ANY($2::uuid[]))::int AS users',
      [[extra.a.accountId, extra.b.accountId], [...Object.values(extra.a.users), ...Object.values(extra.b.users)].map((u) => u.userId)]);
    expect(left.rows[0]).toEqual({ accounts: 0, users: 0 });
  }, 60000);
});
