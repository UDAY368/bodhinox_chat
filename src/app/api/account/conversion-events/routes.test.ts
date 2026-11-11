// Stage 5 (5F) conversion event type routes without a database: any member
// lists the types; adding, renaming, archiving and restoring need a session,
// the Origin + CSRF proof and the admin role, and run as the caller's own
// workspace. Tenancy itself is covered by conversion-events.integration.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const TYPE = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({ role: 'admin', signedIn: true, csrf: true, calls: [] as Array<[string, ...unknown[]]> }));

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  requireSession: async () => {
    if (!h.signedIn) throw new (await import('@/lib/auth/errors')).UnauthorizedError();
    return { userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' };
  },
  assertMutation: async () => {
    if (!h.csrf) throw new (await import('@/lib/auth/account')).ForbiddenError('Invalid CSRF token');
  },
}));
vi.mock('@/lib/analytics/conversion-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/analytics/conversion-events')>();
  return {
    ...actual,
    listConversionEventTypes: async (...args: unknown[]) => { h.calls.push(['list', ...args]); return []; },
    createConversionEventType: async (...args: unknown[]) => {
      h.calls.push(['create', ...args]);
      if (args[1] === 'Taken') throw new actual.ConversionEventError('name_taken');
      return { id: TYPE };
    },
    updateConversionEventType: async (...args: unknown[]) => { h.calls.push(['update', ...args]); },
  };
});

import { GET, POST } from './route';
import { PATCH } from './[id]/route';

const json = (method: string, body: unknown) => new Request('https://app.example.test/api/account/conversion-events', {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const tenant = { accountId: ACCOUNT, userId: USER, role: 'admin' };

beforeEach(() => { h.role = 'admin'; h.signedIn = true; h.csrf = true; h.calls = []; });

describe('conversion event type routes', () => {
  it('lets any member list, uncached, as their own workspace', async () => {
    h.role = 'viewer';
    const res = await GET(new Request('https://app.example.test/api/account/conversion-events'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(h.calls).toEqual([['list', { ...tenant, role: 'viewer' }]]);
  });

  it('lets an admin add, rename, archive and restore', async () => {
    expect((await POST(json('POST', { name: 'Booked call' }))).status).toBe(201);
    expect((await PATCH(json('PATCH', { name: 'Call booked' }), params(TYPE))).status).toBe(200);
    expect((await PATCH(json('PATCH', { archived: true }), params(TYPE))).status).toBe(200);
    expect(h.calls).toEqual([
      ['create', tenant, 'Booked call'],
      ['update', tenant, TYPE, { name: 'Call booked' }],
      ['update', tenant, TYPE, { archived: true }],
    ]);
  });

  it('refuses an agent, a missing CSRF proof and a signed-out caller before any write', async () => {
    h.role = 'agent';
    expect((await POST(json('POST', { name: 'Booked call' }))).status).toBe(403);
    expect((await PATCH(json('PATCH', { archived: true }), params(TYPE))).status).toBe(403);
    h.role = 'admin';
    h.csrf = false;
    expect((await POST(json('POST', { name: 'Booked call' }))).status).toBe(403);
    h.csrf = true;
    h.signedIn = false;
    expect((await PATCH(json('PATCH', { archived: true }), params(TYPE))).status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it('answers a taken name with 409, a malformed id with 404 and an empty patch with 422', async () => {
    const taken = await POST(json('POST', { name: 'Taken' }));
    expect(taken.status).toBe(409);
    expect((await taken.json()).code).toBe('name_taken');
    expect((await PATCH(json('PATCH', { archived: true }), params('x'))).status).toBe(404);
    expect((await PATCH(json('PATCH', {}), params(TYPE))).status).toBe(422);
  });
});
