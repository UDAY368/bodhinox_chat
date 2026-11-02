import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const RULE = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'admin', list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), reorder: vi.fn() }));

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
vi.mock('@/lib/inbox/routing', async (original) => ({
  ...(await original<typeof import('@/lib/inbox/routing')>()),
  listRoutingRules: h.list,
  createRoutingRule: h.create,
  updateRoutingRule: h.update,
  deleteRoutingRule: h.remove,
  reorderRoutingRules: h.reorder,
}));

import { RoutingRuleError } from '@/lib/inbox/routing';
import { GET, POST } from './route';
import { DELETE, PUT } from './[id]/route';
import { POST as REORDER } from './reorder/route';

const tenant = { accountId: ACCOUNT, userId: USER, role: 'admin' };
const body = { name: 'Sales', conditions: { keywords_any: ['price'] }, assign_to: { mode: 'member', user_id: USER } };
const req = (method: string, payload?: unknown) => new Request('http://x', { method, body: payload === undefined ? undefined : JSON.stringify(payload) });
const params = { params: Promise.resolve({ id: RULE }) };

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.list.mockResolvedValue([]);
  h.create.mockImplementation(async (_t: unknown, input: object) => ({ id: RULE, ...input }));
  h.update.mockImplementation(async (_t: unknown, id: string, input: object) => ({ id, ...input }));
  h.remove.mockResolvedValue(undefined);
  h.reorder.mockResolvedValue([]);
});

describe('routing rules routes', () => {
  it.each(['agent', 'viewer'])('refuse a %s everywhere', async (role) => {
    h.role = role;
    const statuses = [
      (await GET()).status, (await POST(req('POST', body))).status, (await PUT(req('PUT', body), params)).status,
      (await DELETE(req('DELETE'), params)).status, (await REORDER(req('POST', { ids: [RULE] }))).status,
    ];
    expect(statuses).toEqual([403, 403, 403, 403, 403]);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.reorder).not.toHaveBeenCalled();
  });

  it('lists and creates as the admin', async () => {
    expect((await GET()).status).toBe(200);
    expect(h.list).toHaveBeenCalledWith(tenant);
    const res = await POST(req('POST', body));
    expect(res.status).toBe(201);
    expect(h.create).toHaveBeenCalledWith(tenant, expect.objectContaining({ name: 'Sales', enabled: true, reassign_after_minutes: null }));
  });

  it('rejects an invalid rule before touching the database', async () => {
    const res = await POST(req('POST', { ...body, assign_to: { mode: 'member' } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_assignee' });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('maps a reference or limit error from the database layer', async () => {
    h.create.mockRejectedValueOnce(new RoutingRuleError('unknown_member'));
    expect(await (await POST(req('POST', body))).json()).toMatchObject({ code: 'unknown_member' });
    h.create.mockRejectedValueOnce(new RoutingRuleError('limit', 409));
    expect((await POST(req('POST', body))).status).toBe(409);
  });

  it('updates, deletes and 404s an unknown rule', async () => {
    expect((await PUT(req('PUT', body), params)).status).toBe(200);
    expect(h.update).toHaveBeenCalledWith(tenant, RULE, expect.objectContaining({ name: 'Sales' }));
    expect((await DELETE(req('DELETE'), params)).status).toBe(200);
    expect(h.remove).toHaveBeenCalledWith(tenant, RULE);
    h.remove.mockRejectedValueOnce(new RoutingRuleError('not_found', 404));
    expect((await DELETE(req('DELETE'), params)).status).toBe(404);
  });

  it('reorders with a validated id list', async () => {
    expect((await REORDER(req('POST', { ids: [RULE] }))).status).toBe(200);
    expect(h.reorder).toHaveBeenCalledWith(tenant, [RULE]);
    expect((await REORDER(req('POST', { ids: [RULE, RULE] }))).status).toBe(400);
  });
});
