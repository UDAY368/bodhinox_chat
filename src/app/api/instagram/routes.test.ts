// Phase 11 T2: the /api/instagram routes. While Instagram is off every route
// but status answers the fixed 503 before any session, database or Instagram
// work (status answers 200 { enabled:false }); then session, CSRF/origin,
// admin role, rate limit and strict bodies; the callback refuses a bad state
// before any code exchange and never puts Meta text in the URL.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const IG = '44444444-4444-4444-8444-444444444444';
const RULE = '55555555-5555-4555-8555-555555555555';

const h = vi.hoisted(() => ({
  role: 'admin', signedIn: true, mutationOk: true, sessions: 0, cookie: null as string | null,
  calls: [] as string[], fail: null as unknown,
}));
const graph = vi.hoisted(() => ({ exchangeCode: vi.fn(), exchangeLongLived: vi.fn(), getMe: vi.fn(), subscribe: vi.fn() }));

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
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'bx_ig_oauth' && h.cookie ? { value: h.cookie } : undefined) }),
}));
vi.mock('@/lib/instagram/graph', async (original) => ({ ...(await original<typeof import('@/lib/instagram/graph')>()), ...graph }));
const view = { id: IG, igUserId: '1789', username: 'shop', status: 'active' };
vi.mock('@/lib/instagram/connection', async (original) => ({
  ...(await original<typeof import('@/lib/instagram/connection')>()),
  startConnect: async (_actor: unknown, options: { comments?: boolean }) => {
    if (h.fail) throw h.fail;
    h.calls.push(`start:${options.comments}`);
    return { url: 'https://www.instagram.com/oauth/authorize?x=1', stateCookie: 'signed-state' };
  },
  listInstagramAccounts: async () => { h.calls.push('list'); return [view]; },
  getInstagramAccountView: async () => { h.calls.push('view'); return view; },
  disconnect: async (_actor: unknown, id: string) => { h.calls.push(`disconnect:${id}`); return { ...view, status: 'disconnected' }; },
}));
vi.mock('@/lib/instagram/health', () => ({
  checkHealth: async (accountId: string, id: string) => { h.calls.push(`health:${accountId}:${id}`); return 'active'; },
}));
vi.mock('@/lib/instagram/comment-rules', () => ({
  listCommentRules: async () => { h.calls.push('rules'); return []; },
  createCommentRule: async (_a: unknown, _id: string, input: unknown) => {
    if (h.fail) throw h.fail;
    h.calls.push(`create:${JSON.stringify(input)}`);
    return { id: RULE };
  },
  updateCommentRule: async (_a: unknown, _id: string, _r: string, patch: unknown) => {
    h.calls.push(`update:${JSON.stringify(patch)}`);
    return { id: RULE };
  },
  deleteCommentRule: async () => { h.calls.push('delete'); },
}));

import { InstagramError } from '@/lib/instagram/errors';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET as status } from './status/route';
import { POST as connect } from './connect/route';
import { GET as callback } from './callback/route';
import { DELETE as disconnectRoute } from './accounts/[id]/route';
import { POST as health } from './accounts/[id]/health/route';
import { GET as listRules, POST as createRule } from './accounts/[id]/comment-rules/route';
import { DELETE as deleteRule, PATCH as patchRule } from './accounts/[id]/comment-rules/[ruleId]/route';

const req = (path: string, method = 'GET', body?: unknown) =>
  new Request(`https://app.example.test${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const idCtx = (id = IG) => ({ params: Promise.resolve({ id }) });
const ruleCtx = (ruleId = RULE, id = IG) => ({ params: Promise.resolve({ id, ruleId }) });

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
  vi.stubEnv('APP_URL', 'https://app.example.test');
  Object.assign(h, { role: 'admin', signedIn: true, mutationOk: true, sessions: 0, cookie: null, calls: [], fail: null });
  for (const fn of Object.values(graph)) fn.mockReset();
  __resetRateLimitForTests();
});

describe('while Instagram is off', () => {
  it('status answers 200 enabled:false with no accounts and no Instagram call', async () => {
    const res = await status(req('/api/instagram/status'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ enabled: false, reason: 'flag_off', accounts: [] });
    expect(h.calls).toEqual([]);
  });

  it('every other route answers 503 instagram_not_enabled before the session', async () => {
    const responses = [
      await connect(req('/api/instagram/connect', 'POST', {})),
      await disconnectRoute(req(`/api/instagram/accounts/${IG}`, 'DELETE'), idCtx()),
      await health(req(`/api/instagram/accounts/${IG}/health`, 'POST'), idCtx()),
      await listRules(req(`/api/instagram/accounts/${IG}/comment-rules`), idCtx()),
      await createRule(req(`/api/instagram/accounts/${IG}/comment-rules`, 'POST', { reply_text: 'hi' }), idCtx()),
      await patchRule(req(`/api/instagram/accounts/${IG}/comment-rules/${RULE}`, 'PATCH', { active: false }), ruleCtx()),
      await deleteRule(req(`/api/instagram/accounts/${IG}/comment-rules/${RULE}`, 'DELETE'), ruleCtx()),
    ];
    for (const res of responses) {
      expect(res.status).toBe(503);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect((await res.json()).error).toBe('instagram_not_enabled');
    }
    expect(h.sessions).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('the callback redirects with the not-enabled code and clears the state cookie', async () => {
    const res = await callback(req('/api/instagram/callback?code=abc&state=x'));
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/settings');
    expect(location.searchParams.get('tab')).toBe('instagram');
    expect(location.searchParams.get('instagram')).toBe('error');
    expect(location.searchParams.get('code')).toBe('instagram_not_enabled');
    expect(res.headers.get('set-cookie')).toMatch(/bx_ig_oauth=;/);
    expect(h.sessions).toBe(0);
  });
});

describe('when enabled', () => {
  beforeEach(enable);

  it('status lists the accounts for any member', async () => {
    h.role = 'agent';
    const res = await status(req('/api/instagram/status'));
    expect(await res.json()).toMatchObject({ enabled: true, appId: '1234567890', accounts: [view] });
    h.signedIn = false;
    expect((await status(req('/api/instagram/status'))).status).toBe(401);
  });

  it('connect needs a session, a valid origin, the admin role and a strict body', async () => {
    h.signedIn = false;
    expect((await connect(req('/api/instagram/connect', 'POST', {}))).status).toBe(401);
    h.signedIn = true;
    h.mutationOk = false;
    expect((await connect(req('/api/instagram/connect', 'POST', {}))).status).toBe(403);
    h.mutationOk = true;
    h.role = 'agent';
    expect((await connect(req('/api/instagram/connect', 'POST', {}))).status).toBe(403);
    h.role = 'admin';
    expect((await connect(req('/api/instagram/connect', 'POST', { comments: 'yes' }))).status).toBe(400);
    expect((await connect(req('/api/instagram/connect', 'POST', { other: 1 }))).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('connect answers the authorize URL and sets an httpOnly Lax state cookie', async () => {
    const res = await connect(req('/api/instagram/connect', 'POST', { comments: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://www.instagram.com/oauth/authorize?x=1' });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/bx_ig_oauth=signed-state/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\/api\/instagram/);
    expect(h.calls).toEqual(['start:true']);
    // An empty body asks for DMs only.
    await connect(new Request('https://app.example.test/api/instagram/connect', { method: 'POST' }));
    expect(h.calls).toEqual(['start:true', 'start:false']);
  });

  it('connect maps service errors and rate limits per user', async () => {
    h.fail = new InstagramError('account_in_use');
    const res = await connect(req('/api/instagram/connect', 'POST', {}));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('account_in_use');
    h.fail = null;
    for (let i = 1; i < 10; i++) expect((await connect(req('/api/instagram/connect', 'POST', {}))).status).toBe(200);
    expect((await connect(req('/api/instagram/connect', 'POST', {}))).status).toBe(429);
  });

  it('the callback refuses a missing or mismatched state before any code exchange', async () => {
    for (const cookie of [null, 'forged.cookie']) {
      h.cookie = cookie;
      const res = await callback(req('/api/instagram/callback?code=abc&state=nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn'));
      const location = new URL(res.headers.get('location')!);
      expect(location.searchParams.get('code')).toBe('state_mismatch');
    }
    expect(graph.exchangeCode).not.toHaveBeenCalled();
  });

  it('the callback reports signed-out, non-admin and declined consent without an exchange', async () => {
    const codeOf = async () => new URL((await callback(req('/api/instagram/callback?code=abc&state=x&error=access_denied')))
      .headers.get('location')!).searchParams.get('code');
    h.signedIn = false;
    expect(await codeOf()).toBe('signed_out');
    h.signedIn = true;
    h.role = 'agent';
    expect(await codeOf()).toBe('forbidden');
    h.role = 'admin';
    expect(await codeOf()).toBe('denied');
    expect(graph.exchangeCode).not.toHaveBeenCalled();
  });

  it('disconnect and health check need an admin mutation and a well-formed id', async () => {
    h.role = 'agent';
    expect((await disconnectRoute(req(`/api/instagram/accounts/${IG}`, 'DELETE'), idCtx())).status).toBe(403);
    expect((await health(req(`/api/instagram/accounts/${IG}/health`, 'POST'), idCtx())).status).toBe(403);
    h.role = 'admin';
    expect((await disconnectRoute(req('/api/instagram/accounts/x', 'DELETE'), idCtx('x'))).status).toBe(404);
    expect((await health(req('/api/instagram/accounts/x/health', 'POST'), idCtx('x'))).status).toBe(404);
    expect(h.calls).toEqual([]);
    const off = await disconnectRoute(req(`/api/instagram/accounts/${IG}`, 'DELETE'), idCtx());
    expect((await off.json()).account.status).toBe('disconnected');
    const checked = await health(req(`/api/instagram/accounts/${IG}/health`, 'POST'), idCtx());
    expect(checked.status).toBe(200);
    expect(h.calls).toEqual([`disconnect:${IG}`, 'view', `health:${ACCOUNT}:${IG}`, 'view']);
  });

  it('comment rules: admin only, strict bodies, mapped fields', async () => {
    h.role = 'agent';
    expect((await listRules(req(`/api/instagram/accounts/${IG}/comment-rules`), idCtx())).status).toBe(403);
    expect((await createRule(req(`/api/instagram/accounts/${IG}/comment-rules`, 'POST', { reply_text: 'hi' }), idCtx())).status).toBe(403);
    h.role = 'admin';
    h.mutationOk = false;
    expect((await deleteRule(req(`/api/instagram/accounts/${IG}/comment-rules/${RULE}`, 'DELETE'), ruleCtx())).status).toBe(403);
    h.mutationOk = true;
    const bad = [{}, { reply_text: '' }, { reply_text: 'hi', media_id: 'abc' }, { reply_text: 'hi', extra: 1 },
      { reply_text: 'hi', keywords: 'price' }];
    for (const body of bad)
      expect((await createRule(req(`/api/instagram/accounts/${IG}/comment-rules`, 'POST', body), idCtx())).status).toBe(400);
    expect((await patchRule(req(`/api/instagram/accounts/${IG}/comment-rules/${RULE}`, 'PATCH', {}), ruleCtx())).status).toBe(400);
    expect((await patchRule(req(`/api/instagram/accounts/${IG}/comment-rules/x`, 'PATCH', { active: false }), ruleCtx('x'))).status).toBe(404);
    expect(h.calls).toEqual([]);

    const created = await createRule(req(`/api/instagram/accounts/${IG}/comment-rules`, 'POST',
      { reply_text: 'hi', keywords: ['Price'], media_id: '1789' }), idCtx());
    expect(created.status).toBe(201);
    await patchRule(req(`/api/instagram/accounts/${IG}/comment-rules/${RULE}`, 'PATCH', { active: false }), ruleCtx());
    expect((await deleteRule(req(`/api/instagram/accounts/${IG}/comment-rules/${RULE}`, 'DELETE'), ruleCtx())).status).toBe(200);
    expect((await listRules(req(`/api/instagram/accounts/${IG}/comment-rules`), idCtx())).status).toBe(200);
    expect(h.calls).toEqual([
      'create:{"mediaId":"1789","keywords":["Price"],"replyText":"hi","active":true}',
      'update:{"active":false}',
      'delete',
      'rules',
    ]);
  });

  it('comment rules answer the permission-missing code from the service', async () => {
    h.fail = new InstagramError('instagram_permission_missing');
    const res = await createRule(req(`/api/instagram/accounts/${IG}/comment-rules`, 'POST', { reply_text: 'hi' }), idCtx());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'instagram_permission_missing' });
  });
});
