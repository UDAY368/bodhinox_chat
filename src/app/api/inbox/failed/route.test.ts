// GET /api/inbox/failed reads only the caller's workspace and refuses without a session.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ calls: [] as unknown[][], denied: false }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async (role: string) => {
    if (h.denied) throw Object.assign(new Error('Unauthorized'), { status: 401 });
    return { accountId: 'acct', userId: 'u-1', role: role === 'viewer' ? 'viewer' : role };
  },
  toErrorResponse: (e: { status?: number }) => new Response(null, { status: e?.status ?? 500 }),
}));
vi.mock('@/lib/inbox/failed-outbound', () => ({
  conversationsWithFailedLastOutbound: async (...args: unknown[]) => { h.calls.push(args); return ['c1']; },
}));

import { GET } from './route';

describe('GET /api/inbox/failed', () => {
  beforeEach(() => { h.calls = []; h.denied = false; });

  it('lists the failed conversations of the caller tenant', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversationIds: ['c1'] });
    expect(h.calls).toEqual([[{ accountId: 'acct', userId: 'u-1', role: 'viewer' }]]);
  });

  it('reads nothing without a session', async () => {
    h.denied = true;
    expect((await GET()).status).toBe(401);
    expect(h.calls).toEqual([]);
  });
});
