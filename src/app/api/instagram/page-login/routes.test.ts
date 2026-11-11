// Stage 4E: the /api/instagram/page-login routes. While the flag is off every route
// answers the fixed 503 (or a redirect with a fixed code) before any session or Meta
// work; then session, Origin/CSRF, admin role, rate limit and strict bodies. The
// callback checks the state before any exchange, never puts a token or Meta text in
// the URL, and the sealed token only ever travels in an httpOnly cookie.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const IG_ID = '17841400000000001';

const h = vi.hoisted(() => ({
  role: 'admin', signedIn: true, mutationOk: true, sessions: 0, cookies: {} as Record<string, string>, calls: [] as unknown[][],
  fail: null as unknown,
}));

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
  cookies: async () => ({ get: (name: string) => (h.cookies[name] ? { value: h.cookies[name] } : undefined) }),
}));
vi.mock('@/lib/instagram/page-login', async (original) => ({
  ...(await original<typeof import('@/lib/instagram/page-login')>()),
  startPageLogin: async () => {
    if (h.fail) throw h.fail;
    h.calls.push(['start']);
    return { url: 'https://www.facebook.com/v26.0/dialog/oauth?x=1', stateCookie: 'signed-state' };
  },
  completePageLogin: async (_actor: unknown, input: unknown) => {
    if (h.fail) throw h.fail;
    h.calls.push(['complete', input]);
    return { pickCookie: 'sealed-pick' };
  },
  listPageAccounts: async (_actor: unknown, pick: string | null) => {
    if (h.fail) throw h.fail;
    h.calls.push(['pages', pick]);
    return [{ instagramUserId: IG_ID, username: 'shop', pageId: '501', pageName: 'Shop Page' }];
  },
  connectPageAccount: async (_actor: unknown, input: unknown) => {
    if (h.fail) throw h.fail;
    h.calls.push(['connect', input]);
    return { instagramAccountId: '44444444-4444-4444-8444-444444444444' };
  },
}));

import { InstagramError } from '@/lib/instagram/errors';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET as callback } from './callback/route';
import { POST as connect } from './connect/route';
import { POST as pages } from './pages/route';
import { POST as start } from './start/route';

const req = (path: string, method = 'POST', body?: unknown) =>
  new Request(`https://app.example.test${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });

function enable() {
  vi.stubEnv('INSTAGRAM_ENABLED', 'true');
  vi.stubEnv('INSTAGRAM_APP_ID', '1234567890');
  vi.stubEnv('INSTAGRAM_APP_SECRET', 'test-only-ig-secret');
  vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'test-only-verify');
  vi.stubEnv('APP_URL', 'https://app.example.test');
  vi.stubEnv('INSTAGRAM_PAGE_LOGIN_ENABLED', 'true');
  vi.stubEnv('META_APP_ID', '9876543210');
  vi.stubEnv('META_APP_SECRET', 'test-only-fb-secret');
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('INSTAGRAM_ENABLED', '');
  Object.assign(h, { role: 'admin', signedIn: true, mutationOk: true, sessions: 0, cookies: {}, calls: [], fail: null });
  __resetRateLimitForTests();
});

describe('while the Page login is off', () => {
  it('answers the fixed 503 before any session work, and the callback redirects with a fixed code', async () => {
    enable();
    vi.stubEnv('INSTAGRAM_PAGE_LOGIN_ENABLED', '');
    for (const [route, body] of [[start, {}], [pages, {}], [connect, { instagramUserId: IG_ID }]] as const) {
      const res = await route(req('/api/instagram/page-login/x', 'POST', body));
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('instagram_not_enabled');
    }
    const res = await callback(req('/api/instagram/page-login/callback?code=abc&state=s', 'GET'));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get('location')!).searchParams.get('code')).toBe('instagram_not_enabled');
    expect(h.sessions).toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe('when enabled', () => {
  beforeEach(enable);

  it.each([['start', start, {}], ['pages', pages, {}], ['connect', connect, { instagramUserId: IG_ID }]] as const)(
    '%s needs a session, a valid Origin/CSRF proof and the admin role', async (_name, route, body) => {
      h.signedIn = false;
      expect((await route(req('/api/instagram/page-login/x', 'POST', body))).status).toBe(401);
      h.signedIn = true;
      h.mutationOk = false;
      expect((await route(req('/api/instagram/page-login/x', 'POST', body))).status).toBe(403);
      h.mutationOk = true;
      h.role = 'agent';
      expect((await route(req('/api/instagram/page-login/x', 'POST', body))).status).toBe(403);
      expect(h.calls).toEqual([]);
    });

  it('start answers the Facebook URL and sets an httpOnly Lax state cookie scoped to the page-login path', async () => {
    const res = await start(req('/api/instagram/page-login/start', 'POST', {}));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toMatch(/^https:\/\/www\.facebook\.com\//);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain('bx_ig_pl_state=signed-state');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toContain('Path=/api/instagram/page-login');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect((await start(req('/api/instagram/page-login/start', 'POST', { extra: 1 }))).status).toBe(400);
  });

  it('callback passes the state, the cookie and the code on, seals the pick cookie, and keeps secrets out of the URL', async () => {
    h.cookies.bx_ig_pl_state = 'state-cookie';
    const res = await callback(req('/api/instagram/page-login/callback?code=abc&state=nonce', 'GET'));
    expect(res.status).toBe(303);
    const target = new URL(res.headers.get('location')!);
    expect(target.pathname).toBe('/settings');
    expect(target.searchParams.get('instagram_pl')).toBe('select');
    expect(target.search).not.toContain('sealed-pick');
    expect(target.search).not.toContain('abc');
    expect(h.calls[0]).toEqual(['complete', { state: 'nonce', cookieState: 'state-cookie', code: 'abc' }]);
    const cookies = res.headers.getSetCookie();
    const pick = cookies.find((c) => c.startsWith('bx_ig_pl_pick='))!;
    expect(pick).toContain('sealed-pick');
    expect(pick).toMatch(/HttpOnly/i);
    expect(pick).toContain('Path=/api/instagram/page-login');
    expect(cookies.find((c) => c.startsWith('bx_ig_pl_state='))).toMatch(/Max-Age=0/i);
  });

  it('callback redirects with fixed codes for sign-out, role, decline and failures', async () => {
    const codeFor = async (r: Response) => new URL(r.headers.get('location')!).searchParams.get('code');
    h.signedIn = false;
    expect(await codeFor(await callback(req('/api/instagram/page-login/callback', 'GET')))).toBe('signed_out');
    h.signedIn = true;
    h.role = 'agent';
    expect(await codeFor(await callback(req('/api/instagram/page-login/callback', 'GET')))).toBe('forbidden');
    h.role = 'admin';
    expect(await codeFor(await callback(req('/api/instagram/page-login/callback?error=access_denied', 'GET')))).toBe('denied');
    h.fail = new InstagramError('state_mismatch');
    expect(await codeFor(await callback(req('/api/instagram/page-login/callback?code=a&state=b', 'GET')))).toBe('state_mismatch');
    h.fail = new InstagramError('instagram_permission_missing');
    expect(await codeFor(await callback(req('/api/instagram/page-login/callback?code=a&state=b', 'GET')))).toBe('instagram_permission_missing');
    h.fail = new Error('EAAG-leak should never appear');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = await callback(req('/api/instagram/page-login/callback?code=a&state=b', 'GET'));
    expect(await codeFor(failed)).toBe('save_failed');
    expect(failed.headers.get('location')).not.toContain('EAAG');
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain('EAAG');
    expect(failed.headers.getSetCookie().some((c) => c.startsWith('bx_ig_pl_pick=') && !/Max-Age=0/i.test(c))).toBe(false);
  });

  it('pages returns ids and names read through the sealed cookie, never a token', async () => {
    h.cookies.bx_ig_pl_pick = 'sealed-pick';
    const res = await pages(req('/api/instagram/page-login/pages', 'POST', {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accounts: [{ instagramUserId: IG_ID, username: 'shop', pageId: '501', pageName: 'Shop Page' }] });
    expect(h.calls[0]).toEqual(['pages', 'sealed-pick']);
  });

  it('connect takes only an Instagram user id, clears the sealed cookie and answers fixed errors', async () => {
    h.cookies.bx_ig_pl_pick = 'sealed-pick';
    const res = await connect(req('/api/instagram/page-login/connect', 'POST', { instagramUserId: IG_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ instagramAccountId: '44444444-4444-4444-8444-444444444444' });
    expect(h.calls[0]).toEqual(['connect', { pickCookie: 'sealed-pick', instagramUserId: IG_ID }]);
    expect(res.headers.get('set-cookie')).toMatch(/bx_ig_pl_pick=;.*Max-Age=0/i);
    for (const body of [{}, { instagramUserId: 'abc' }, { instagramUserId: IG_ID, pageId: '501' }, { instagramUserId: IG_ID, token: 'EAAG-x' }])
      expect((await connect(req('/api/instagram/page-login/connect', 'POST', body))).status).toBe(400);
    h.fail = new InstagramError('account_in_use');
    const taken = await connect(req('/api/instagram/page-login/connect', 'POST', { instagramUserId: IG_ID }));
    expect(taken.status).toBe(409);
    expect((await taken.json()).error).toBe('account_in_use');
  });
});
