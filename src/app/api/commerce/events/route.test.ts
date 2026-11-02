import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ role: 'admin', list: vi.fn() }));

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
vi.mock('@/lib/commerce/event-attention', async (original) => ({
  ...(await original<typeof import('@/lib/commerce/event-attention')>()),
  listAttentionEvents: h.list,
}));

import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.list.mockResolvedValue({ events: [{ id: 'e1', reason: 'outcome_unknown' }] });
});

describe('GET /api/commerce/events', () => {
  it('lists events needing attention for admins as the caller', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ events: [{ id: 'e1', reason: 'outcome_unknown' }] });
    expect(h.list).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'admin' });
  });

  it.each(['agent', 'viewer'])('refuses %s', async (role) => {
    h.role = role;
    expect((await GET()).status).toBe(403);
    expect(h.list).not.toHaveBeenCalled();
  });
});
