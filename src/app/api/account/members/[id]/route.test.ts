import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({
  role: 'admin',
  target: 'agent' as string | null,
  updates: [] as unknown[][],
  rpc: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (original) => {
  const actual = await original<typeof import('@/lib/auth/account')>();
  return {
    ...actual,
    requireRole: async (min: string) => {
      if (min === 'admin' && !['owner', 'admin'].includes(h.role)) throw new actual.ForbiddenError('Insufficient workspace role');
      return { db: { rpc: h.rpc }, userId: ADMIN, accountId: ACCOUNT, role: h.role, account: { id: ACCOUNT, name: 'Acme' } };
    },
  };
});
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: vi.fn(), RATE_LIMITS: {} }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, op: (tx: unknown) => unknown) =>
    op({
      $queryRaw: async () => (h.target ? [{ role: h.target }] : []),
      $executeRaw: async (...args: unknown[]) => {
        h.updates.push(args);
        return 1;
      },
    }),
}));

import { PATCH } from './route';

const patch = (body: unknown, id = MEMBER) =>
  PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  h.role = 'admin';
  h.target = 'agent';
  h.updates = [];
  h.rpc.mockReset().mockResolvedValue({ data: null, error: null });
});

describe('PATCH mask_phone_numbers', () => {
  it('lets an admin mask and unmask an agent or viewer', async () => {
    const res = await patch({ mask_phone_numbers: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mask_phone_numbers: true });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toContain(true);
    h.target = 'viewer';
    expect((await patch({ mask_phone_numbers: false })).status).toBe(200);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('refuses masking an owner or admin, unknown members and bad input', async () => {
    h.target = 'admin';
    expect((await patch({ mask_phone_numbers: true })).status).toBe(400);
    h.target = null;
    expect((await patch({ mask_phone_numbers: true })).status).toBe(404);
    expect((await patch({ mask_phone_numbers: true }, 'not-a-uuid')).status).toBe(404);
    expect((await patch({ mask_phone_numbers: 'yes' })).status).toBe(400);
    expect((await patch({ mask_phone_numbers: true, role: 'agent' })).status).toBe(400);
    expect(h.updates).toHaveLength(0);
  });

  it('is admin-only', async () => {
    h.role = 'agent';
    expect((await patch({ mask_phone_numbers: true })).status).toBe(403);
    expect(h.updates).toHaveLength(0);
  });

  it('still changes roles through the RPC', async () => {
    expect((await patch({ role: 'viewer' })).status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith('set_member_role', { p_user_id: MEMBER, p_new_role: 'viewer' });
  });

  it('answers a user who is not a member of this workspace (P0002) with 404, other refusals unchanged', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0002', message: 'Member not found' } });
    expect((await patch({ role: 'viewer' })).status).toBe(404);
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'The owner cannot be removed or demoted' } });
    expect((await patch({ role: 'viewer' })).status).toBe(400);
  });
});
