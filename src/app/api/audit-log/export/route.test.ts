import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ role: 'admin', rows: [] as unknown[], writes: [] as unknown[][], tenants: [] as unknown[] }));

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
  withTenant: async (tenant: unknown, fn: (tx: unknown) => unknown) => {
    h.tenants.push(tenant);
    return fn({
      $queryRaw: async () => h.rows,
      $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => { h.writes.push(values); return 1; },
    });
  },
}));

import { GET } from './route';

const row = {
  id: '00000000-0000-4000-8000-000000000001', at_key: '2026-11-02 10:00:00+00', action: 'team.created', user_id: USER,
  name: '=cmd|calc', resource_id: 'abc', metadata: { members: 2, note: 'customer said hi there' }, created_at: new Date('2026-11-02T10:00:00Z'),
};

beforeEach(() => {
  h.role = 'admin';
  h.rows = [];
  h.writes = [];
  h.tenants = [];
});

it.each(['agent', 'viewer'])('refuses a %s without reading anything', async (role) => {
  h.role = role;
  expect((await GET(new Request('http://x/api/audit-log/export'))).status).toBe(403);
  expect(h.tenants).toEqual([]);
});

it('exports the caller’s workspace as safe CSV and audits the export', async () => {
  h.rows = [row];
  const res = await GET(new Request('http://x/api/audit-log/export?q=team&category=team'));
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type')).toContain('text/csv');
  expect(res.headers.get('Content-Disposition')).toMatch(/attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"/);
  expect(res.headers.get('Cache-Control')).toContain('no-store');
  expect(res.headers.get('X-Rows')).toBe('1');
  const csv = await res.text();
  expect(csv.split('\r\n')[0]).toBe('"time","member","action","category","resource","details"');
  expect(csv).toContain(`"'=cmd|calc"`);
  expect(csv).toContain('"members=2"');
  expect(csv).not.toContain('customer said');
  // Scoped to the session's workspace, and the export itself is recorded.
  expect(h.tenants[0]).toMatchObject({ accountId: ACCOUNT, userId: USER });
  expect(h.writes).toHaveLength(1);
  expect(h.writes[0]).toContain(ACCOUNT);
});

it('rejects a malformed query', async () => {
  expect((await GET(new Request('http://x/api/audit-log/export?category=all-of-it'))).status).toBe(400);
});
