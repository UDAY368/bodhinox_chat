import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ENDPOINT = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({
  role: 'admin',
  endpoint: [] as unknown[],
  rows: [] as unknown[],
  sql: [] as string[],
  params: [] as unknown[][],
  contexts: [] as unknown[],
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }),
}));
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
  withTenant: async (ctx: unknown, fn: (tx: unknown) => unknown) => {
    h.contexts.push(ctx);
    return fn({
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        h.sql.push(sql);
        h.params.push(values);
        return sql.includes('FROM webhook_endpoints') ? h.endpoint : h.rows;
      },
    });
  },
}));

import { GET } from './route';

const get = (id: string) =>
  GET(new Request(`http://x/api/account/webhooks/${id}/deliveries`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  h.role = 'admin';
  h.endpoint = [{ id: ENDPOINT }];
  h.rows = [];
  h.sql = [];
  h.params = [];
  h.contexts = [];
});

it.each(['agent', 'viewer'])('refuses a %s without querying', async (role) => {
  h.role = role;
  expect((await get(ENDPOINT)).status).toBe(403);
  expect(h.sql).toEqual([]);
});

it('lists the log newest first for an admin, scoped to the caller workspace, uncached', async () => {
  h.rows = [
    { id: 'd2', event: 'message.received', delivery_id: 'p1', attempt: 2, outcome: 'delivered', http_status: 200, error: null, created_at: new Date('2026-11-10T10:00:02Z') },
    { id: 'd1', event: 'message.received', delivery_id: 'p1', attempt: 1, outcome: 'failed', http_status: 503, error: 'http_status', created_at: new Date('2026-11-10T10:00:01Z') },
  ];
  const res = await get(ENDPOINT);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  const body = await res.json();
  expect(body.deliveries.map((d: { id: string }) => d.id)).toEqual(['d2', 'd1']);
  expect(body.deliveries[1]).toMatchObject({ outcome: 'failed', http_status: 503, error: 'http_status', created_at: '2026-11-10T10:00:01.000Z' });
  expect(h.contexts).toEqual([{ accountId: ACCOUNT, userId: USER, role: 'admin' }]);
  // Every statement names the caller's account; the log is bounded.
  expect(h.params.every((values) => values[0] === ACCOUNT)).toBe(true);
  expect(h.sql[1]).toMatch(/ORDER BY created_at DESC, id DESC LIMIT/);
  expect(h.params[1]).toContain(100);
});

it('answers 404 for an id that is not an endpoint of this workspace, and for a malformed id', async () => {
  h.endpoint = [];
  expect((await get(ENDPOINT)).status).toBe(404);
  expect(h.sql).toHaveLength(1);
  h.sql = [];
  expect((await get('not-a-uuid')).status).toBe(404);
  expect(h.sql).toEqual([]);
});
