import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ role: 'admin', rows: [] as unknown[], calls: 0 }));

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
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_t: unknown, fn: (tx: unknown) => unknown) =>
    fn({ $queryRaw: async () => (h.calls++ === 0 ? h.rows : [{ action: 'team.created' }]) }),
}));

import { GET } from './route';

const row = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, at_key: `2026-11-02 10:00:0${n}.123456+00`, action: 'team.created',
  user_id: USER, name: 'Asha', resource_id: 'abc', metadata: { members: 2, note: 'customer said hi there' },
  created_at: new Date(`2026-11-02T10:00:0${n}Z`),
});

beforeEach(() => {
  h.role = 'admin';
  h.calls = 0;
  h.rows = [];
});

it.each(['agent', 'viewer'])('refuses a %s', async (role) => {
  h.role = role;
  expect((await GET(new Request('http://x/api/audit-log'))).status).toBe(403);
});

it('pages newest first and strips free text from metadata', async () => {
  h.rows = [row(3), row(2), row(1)];
  const res = await GET(new Request('http://x/api/audit-log?limit=2'));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.entries).toHaveLength(2);
  expect(body.entries[0]).toEqual({
    id: row(3).id, action: 'team.created', actor: { user_id: USER, name: 'Asha' }, resource_id: 'abc',
    metadata: { members: 2 }, created_at: '2026-11-02T10:00:03.000Z',
  });
  expect(JSON.stringify(body)).not.toContain('customer said');
  expect(body.next_cursor).toBeTruthy();
  expect(body.actions).toEqual(['team.created']);
});

it('rejects a malformed query', async () => {
  expect((await GET(new Request('http://x/api/audit-log?actor=me'))).status).toBe(400);
});
