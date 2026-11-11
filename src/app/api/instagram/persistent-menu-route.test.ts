// Stage 3 (3D): the persistent-menu route. While Instagram is off it answers
// 503 before any session or database work; then session, Origin/CSRF, admin
// role, rate limit and strict bodies, and only then the service (mocked here;
// persistent-menu.integration.test.ts runs it on PostgreSQL).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const IG = '44444444-4444-4444-8444-444444444444';
const FLOW = '66666666-6666-4666-8666-666666666666';

const h = vi.hoisted(() => ({ role: 'admin', signedIn: true, mutationOk: true, sessions: 0, calls: [] as string[], fail: null as unknown }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    h.sessions++;
    if (!h.signedIn) throw new (await import('@/lib/auth/errors')).UnauthorizedError();
    return { userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' };
  },
  assertMutation: async () => {
    if (!h.mutationOk) throw new (await import('@/lib/auth/errors')).ForbiddenError('Invalid origin');
  },
}));
vi.mock('@/lib/instagram/persistent-menu', async (original) => ({
  ...(await original<typeof import('@/lib/instagram/persistent-menu')>()),
  getPersistentMenu: async (actor: { accountId: string; role: string }, id: string) => {
    if (h.fail) throw h.fail;
    h.calls.push(`get:${actor.accountId}:${actor.role}:${id}`);
    return { instagramAccountId: id, managed: true, syncedAt: null, items: [] };
  },
  setPersistentMenuItems: async (actor: { accountId: string }, id: string, items: unknown) => {
    if (h.fail) throw h.fail;
    h.calls.push(`set:${actor.accountId}:${id}:${JSON.stringify(items)}`);
    return { instagramAccountId: id, managed: true, syncedAt: null, items: [] };
  },
}));

import { InstagramError } from '@/lib/instagram/errors';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET, PUT } from './accounts/[id]/persistent-menu/route';

const req = (path: string, method = 'GET', body?: unknown) =>
  new Request(`https://app.example.test${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id = IG) => ({ params: Promise.resolve({ id }) });
const PATH = `/api/instagram/accounts/${IG}/persistent-menu`;
const goodBody = { items: [{ type: 'postback', title: 'Book', flow_id: FLOW }, { type: 'web_url', title: 'Site', url: 'https://example.com' }] };

function enable() {
  vi.stubEnv('INSTAGRAM_ENABLED', 'true');
  vi.stubEnv('INSTAGRAM_APP_ID', '1234567890');
  vi.stubEnv('INSTAGRAM_APP_SECRET', 'test-only-ig-secret');
  vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'test-only-verify');
  vi.stubEnv('APP_URL', 'https://app.example.test');
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('INSTAGRAM_ENABLED', '');
  Object.assign(h, { role: 'admin', signedIn: true, mutationOk: true, sessions: 0, calls: [], fail: null });
  __resetRateLimitForTests();
});

describe('persistent menu route', () => {
  it('answers 503 before the session while Instagram is off', async () => {
    for (const res of [await GET(req(PATH), ctx()), await PUT(req(PATH, 'PUT', goodBody), ctx())]) {
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('instagram_not_enabled');
    }
    expect(h.sessions).toBe(0);
    expect(h.calls).toEqual([]);
  });

  describe('when enabled', () => {
    beforeEach(enable);

    it('GET is open to any member, scoped to the session account, and refuses a signed-out caller or bad id', async () => {
      h.role = 'viewer';
      const res = await GET(req(PATH), ctx());
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(h.calls).toEqual([`get:${ACCOUNT}:viewer:${IG}`]);
      h.signedIn = false;
      expect((await GET(req(PATH), ctx())).status).toBe(401);
      h.signedIn = true;
      expect((await GET(req('/api/instagram/accounts/x/persistent-menu'), ctx('x'))).status).toBe(404);
      expect(h.calls).toHaveLength(1);
    });

    it('PUT needs Origin/CSRF proof and an admin', async () => {
      h.mutationOk = false;
      expect((await PUT(req(PATH, 'PUT', goodBody), ctx())).status).toBe(403);
      h.mutationOk = true;
      for (const role of ['agent', 'viewer']) {
        h.role = role;
        const res = await PUT(req(PATH, 'PUT', goodBody), ctx());
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe('forbidden');
      }
      expect(h.calls).toEqual([]);
    });

    it('PUT refuses a body that is not a strict list of at most 20 menu items', async () => {
      const bad = [
        null, {}, { items: 'x' }, { items: [{ type: 'postback', title: 'a' }] }, { items: [{ type: 'other', title: 'a' }] },
        { items: [{ type: 'web_url', title: 'a', url: 'https://x.test', extra: 1 }] },
        { items: Array.from({ length: 21 }, (_, i) => ({ type: 'web_url', title: `T${i}`, url: 'https://x.test' })) },
        { ...goodBody, more: true },
      ];
      for (const body of bad) {
        const res = await PUT(req(PATH, 'PUT', body), ctx());
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('invalid_request');
      }
      expect(h.calls).toEqual([]);
    });

    it('PUT passes the items to the service for the session account', async () => {
      const res = await PUT(req(PATH, 'PUT', goodBody), ctx());
      expect(res.status).toBe(200);
      expect(h.calls).toEqual([`set:${ACCOUNT}:${IG}:${JSON.stringify([
        { type: 'postback', title: 'Book', flowId: FLOW }, { type: 'web_url', title: 'Site', url: 'https://example.com' },
      ])}`]);
    });

    it('maps service refusals to their statuses', async () => {
      for (const [code, status] of [['invalid_request', 400], ['not_found', 404], ['rate_limited', 429], ['meta_error', 502]] as const) {
        h.fail = new InstagramError(code);
        expect((await PUT(req(PATH, 'PUT', goodBody), ctx())).status).toBe(status);
      }
    });
  });
});
