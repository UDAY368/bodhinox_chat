import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ role: 'viewer', limited: false, search: vi.fn(), limitKey: '' }));

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
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (key: string) => { h.limitKey = key; return { success: !h.limited }; },
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({ tx: true }) }));
vi.mock('@/lib/inbox/search', async (original) => ({
  ...(await original<typeof import('@/lib/inbox/search')>()),
  searchInboxMessages: h.search,
}));

import { GET } from './route';

const url = (q: string) => new Request(`http://localhost/api/inbox/search?${q}`);

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'viewer';
  h.limited = false;
  h.search.mockResolvedValue({ results: [], next_cursor: null, mode: 'fulltext' });
});

describe('GET /api/inbox/search', () => {
  it('lets a viewer search, scoped to their tenant and user', async () => {
    const res = await GET(url('q=refund&assignee=me&status=open'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ results: [], next_cursor: null, mode: 'fulltext' });
    expect(h.limitKey).toBe(`inbox-search:${USER}`);
    expect(h.search).toHaveBeenCalledWith({ tx: true }, { accountId: ACCOUNT, userId: USER, role: 'viewer' },
      expect.objectContaining({ query: 'refund', filters: { assignee: USER, status: 'open' } }));
  });

  it('rejects bad input before touching the database', async () => {
    expect((await GET(url('q='))).status).toBe(400);
    expect((await GET(url('q=x&status=bogus'))).status).toBe(400);
    expect(h.search).not.toHaveBeenCalled();
  });

  it('rate limits per user', async () => {
    h.limited = true;
    expect((await GET(url('q=refund'))).status).toBe(429);
    expect(h.search).not.toHaveBeenCalled();
  });

  it('maps a statement timeout to 503 and keeps other failures generic', async () => {
    h.search.mockRejectedValueOnce(Object.assign(new Error('raw'), { code: 'P2010', meta: { code: '57014' } }));
    expect((await GET(url('q=refund'))).status).toBe(503);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.search.mockRejectedValueOnce(new Error('customer text leak'));
    const res = await GET(url('q=refund'));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('customer text');
    expect(JSON.stringify(log.mock.calls)).not.toContain('customer text');
    log.mockRestore();
  });
});
