import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ role: 'admin', rows: [] as { role: string; permission: string }[], set: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }) }));
vi.mock('@/lib/data/server', () => ({
  createClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: { id: ACCOUNT, name: 'Acme' }, error: null });
      return b;
    },
  }),
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_t: unknown, fn: (tx: unknown) => unknown) => fn({ $queryRaw: async () => h.rows }) }));
vi.mock('@/lib/auth/permissions', async (original) => ({
  ...(await original<typeof import('@/lib/auth/permissions')>()),
  setRestriction: h.set,
}));

import { GET, PUT } from './route';

const put = (body: unknown) => PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.rows = [];
  h.set.mockImplementation(async (_t: unknown, role: string, permission: string, allowed: boolean) => (allowed ? [] : [{ role, permission }]));
});

describe('account permissions routes', () => {
  it.each(['agent', 'viewer'])('refuse a %s', async (role) => {
    h.role = role;
    expect((await GET()).status).toBe(403);
    expect((await put({ role: 'viewer', permission: 'campaigns.send', allowed: false })).status).toBe(403);
    expect(h.set).not.toHaveBeenCalled();
  });

  it('returns the matrix with restrictions applied and editable roles', async () => {
    h.rows = [{ role: 'agent', permission: 'campaigns.send' }];
    const body = await (await GET()).json();
    expect(body.matrix.agent['campaigns.send']).toBe(false);
    expect(body.matrix.admin['campaigns.send']).toBe(true);
    expect(body.matrix.viewer['campaigns.send']).toBe(false);
    expect(body.editable_roles).toEqual(['agent', 'viewer']);
  });

  it('can only restrict: allowing a feature above the ceiling still leaves it off', async () => {
    const res = await put({ role: 'viewer', permission: 'contacts.export', allowed: true });
    expect(res.status).toBe(200);
    expect((await res.json()).matrix.viewer['contacts.export']).toBe(false);
  });

  it('lets only an owner restrict admins, and never the owner role', async () => {
    expect((await put({ role: 'admin', permission: 'settings.billing', allowed: false })).status).toBe(403);
    expect((await put({ role: 'owner', permission: 'settings.billing', allowed: false })).status).toBe(400);
    expect(h.set).not.toHaveBeenCalled();
    h.role = 'owner';
    const res = await put({ role: 'admin', permission: 'settings.billing', allowed: false });
    expect(res.status).toBe(200);
    expect(h.set).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'owner' }, 'admin', 'settings.billing', false);
    expect((await res.json()).matrix.admin['settings.billing']).toBe(false);
  });

  it('rejects unknown permissions and malformed bodies', async () => {
    for (const body of [{ role: 'agent', permission: 'everything', allowed: false }, { role: 'agent', permission: 'campaigns.send' }, null])
      expect((await put(body)).status).toBe(400);
  });
});
