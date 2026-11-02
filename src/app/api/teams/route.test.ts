import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const TEAM = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'admin', list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }));

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
vi.mock('@/lib/teams/teams', async (original) => ({
  ...(await original<typeof import('@/lib/teams/teams')>()),
  listTeams: h.list, createTeam: h.create, updateTeam: h.update, deleteTeam: h.remove,
}));

import { TeamError } from '@/lib/teams/teams';
import { GET, POST } from './route';
import { DELETE, PUT } from './[id]/route';

const tenant = { accountId: ACCOUNT, userId: USER, role: 'admin' };
const req = (method: string, payload?: unknown) => new Request('http://x', { method, body: payload === undefined ? undefined : JSON.stringify(payload) });
const params = { params: Promise.resolve({ id: TEAM }) };

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.list.mockResolvedValue([{ id: TEAM, name: 'Sales', member_ids: [USER], created_at: 'x' }]);
  h.create.mockImplementation(async (_t: unknown, input: object) => ({ id: TEAM, ...input }));
  h.update.mockImplementation(async (_t: unknown, id: string, input: object) => ({ id, ...input }));
  h.remove.mockResolvedValue(undefined);
});

describe('teams routes', () => {
  it.each(['agent', 'viewer'])('let a %s list teams (for the inbox filter) but change nothing', async (role) => {
    h.role = role;
    const list = await GET();
    expect(list.status).toBe(200);
    expect((await list.json()).teams).toHaveLength(1);
    expect((await POST(req('POST', { name: 'X' }))).status).toBe(403);
    expect((await PUT(req('PUT', { name: 'X' }), params)).status).toBe(403);
    expect((await DELETE(req('DELETE'), params)).status).toBe(403);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('creates, updates and deletes in the caller tenant', async () => {
    const created = await POST(req('POST', { name: ' Sales ', member_ids: [USER] }));
    expect(created.status).toBe(201);
    expect(h.create).toHaveBeenCalledWith(tenant, { name: 'Sales', member_ids: [USER] });
    expect((await PUT(req('PUT', { member_ids: [] }), params)).status).toBe(200);
    expect(h.update).toHaveBeenCalledWith(tenant, TEAM, { member_ids: [] });
    expect((await DELETE(req('DELETE'), params)).status).toBe(200);
    expect(h.remove).toHaveBeenCalledWith(tenant, TEAM);
  });

  it('maps validation and conflicts to coded errors', async () => {
    expect((await POST(req('POST', { member_ids: ['x'] }))).status).toBe(400);
    h.create.mockRejectedValueOnce(new TeamError('duplicate_name', 409));
    const dup = await POST(req('POST', { name: 'Sales' }));
    expect(dup.status).toBe(409);
    expect((await dup.json()).code).toBe('duplicate_name');
    h.remove.mockRejectedValueOnce(new TeamError('not_found', 404));
    expect((await DELETE(req('DELETE'), params)).status).toBe(404);
  });
});
