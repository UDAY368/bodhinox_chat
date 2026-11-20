import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CONTACT = '44444444-4444-4444-8444-444444444444';
const APPT = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  authed: true,
  contactExists: true,
  rows: [] as unknown[],
  queries: [] as { sql: string; values: unknown[] }[],
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    if (!h.authed) {
      const { UnauthorizedError } = await import('@/lib/auth/errors');
      throw new UnauthorizedError();
    }
    return { userId: '22222222-2222-4222-8222-222222222222', accountId: ACCOUNT, role: 'viewer', sessionId: 's' };
  },
  assertMutation: async () => undefined,
}));
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: async () => undefined }));
vi.mock('@/lib/billing/entitlements', async (original) => ({
  ...(await original<typeof import('@/lib/billing/entitlements')>()),
  requireFeature: async () => undefined,
}));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, work: (tx: unknown) => Promise<unknown>) => work({
    $queryRaw: async (s: TemplateStringsArray, ...values: unknown[]) => {
      const sql = s.join('?');
      h.queries.push({ sql, values });
      if (sql.includes('FROM contacts')) return h.contactExists ? [{ id: CONTACT }] : [];
      return h.rows;
    },
  }),
}));

import { GET } from './route';

const call = (query = '', id = CONTACT) =>
  GET(new Request(`http://localhost/api/appointments/contact/${id}${query}`), { params: Promise.resolve({ contactId: id }) });

const row = (n: number) => ({
  id: `33333333-3333-4333-8333-33333333333${n}`, service_name: 'Consult', start_at: new Date(Date.UTC(2026, 11, n, 5)),
  end_at: new Date(Date.UTC(2026, 11, n, 6)), timezone: 'Asia/Kolkata', status: 'confirmed', payment_status: 'none',
});

beforeEach(() => { h.authed = true; h.contactExists = true; h.rows = []; h.queries = []; });

describe('GET /api/appointments/contact/[contactId]', () => {
  it('needs a session', async () => {
    h.authed = false;
    expect((await call()).status).toBe(401);
  });

  it('returns both first pages scoped to the workspace and contact, with no customer fields', async () => {
    h.rows = [row(1)];
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upcoming.items[0]).toEqual({
      id: row(1).id, service_name: 'Consult', start_at: row(1).start_at.toISOString(), end_at: row(1).end_at.toISOString(),
      timezone: 'Asia/Kolkata', status: 'confirmed', payment_status: 'none',
    });
    expect(body.past.next).toBeNull();
    for (const q of h.queries) {
      expect(q.values).toContain(ACCOUNT);
      expect(q.sql).not.toMatch(/outcome_note|hold_code|intake|phone/);
    }
  });

  it('pages with a next cursor when there are more rows than the limit', async () => {
    h.rows = [row(1), row(2), row(3)];
    const body = await (await call('?kind=upcoming&limit=2')).json();
    expect(body.items).toHaveLength(2);
    expect(body.next).toBe(`${row(2).start_at.toISOString()}_${row(2).id}`);
    h.rows = [row(3)];
    const next = await (await call(`?kind=upcoming&limit=2&cursor=${encodeURIComponent(body.next)}`)).json();
    expect(next).toEqual({ items: [expect.objectContaining({ id: row(3).id })], next: null });
    expect(h.queries.at(-1)!.values).toEqual(expect.arrayContaining([row(2).start_at.toISOString(), row(2).id]));
  });

  it('caps the page size', async () => {
    await call('?kind=past&limit=500');
    expect(h.queries.at(-1)!.values).toContain(21);
  });

  it('another workspace\'s contact (or a bad id) is a 404', async () => {
    h.contactExists = false;
    expect((await call()).status).toBe(404);
    expect((await call('', 'not-a-uuid')).status).toBe(404);
  });

  it('rejects a bad kind, limit or cursor', async () => {
    expect((await call('?kind=all')).status).toBe(400);
    expect((await call('?limit=0')).status).toBe(400);
    expect((await call('?kind=past&cursor=garbage')).status).toBe(400);
    expect((await call(`?cursor=${APPT}`)).status).toBe(400);
  });
});
