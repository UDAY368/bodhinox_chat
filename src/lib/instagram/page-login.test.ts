// Stage 4E: Facebook Page / Business Login without a database. Meta's answers are
// documented-shape fixtures (needing a live capture before the flag is turned on).
// Covers: nothing runs while the flag is off; the state is checked before any Meta
// call; the user token only ever lives sealed in the pick cookie; the Page and its
// token come from Meta's list, never from the client; no token reaches a returned
// value or a log line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const conn = vi.hoisted(() => ({
  saveConnection: vi.fn(), ownerOf: vi.fn(), asWorker: vi.fn(), requireEntitled: vi.fn(), requireRoomUnlessHeld: vi.fn(),
}));
vi.mock('./connection', async (original) => ({ ...(await original<typeof import('./connection')>()), ...conn }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));

import { signInstagramState } from './connection';
import { InstagramError } from './errors';
import {
  completePageLogin, connectPageAccount, listPageAccounts, openPick, PAGE_LOGIN_TTL_MS, probePageLink, readPageLoginState,
  scopesFromPermissions, sealPick, signPageLoginState, startPageLogin,
} from './page-login';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const USER = '22222222-2222-4222-8222-222222222222';
const admin = { accountId: ACCOUNT, userId: USER, role: 'admin' as const };
const FB_SECRET = 'test-only-fb-secret';
const NONCE = 'n'.repeat(32);
const SHORT = 'EAAG-test-only-short-token';
const LONG = 'EAAG-test-only-long-token';
const PAGE_TOKEN = 'EAAG-test-only-page-token';
const ALL_PERMISSIONS = ['pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments'];

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const urls = () => fetchMock.mock.calls.map(([url]) => String(url));

function meta(permissions: string[] = ALL_PERMISSIONS) {
  fetchMock.mockImplementation(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/oauth/access_token')) {
      return json({ access_token: url.searchParams.get('grant_type') === 'fb_exchange_token' ? LONG : SHORT, expires_in: 5_000_000 });
    }
    if (url.pathname.endsWith('/me/permissions')) return json({ data: permissions.map((permission) => ({ permission, status: 'granted' })) });
    if (url.pathname.endsWith('/me/accounts')) {
      return json({ data: [
        { id: '501', name: 'Shop Page', access_token: PAGE_TOKEN, instagram_business_account: { id: '17841400000000001', username: 'shop' } },
        { id: '502', name: 'No Instagram', access_token: 'EAAG-test-only-other-page' },
      ] });
    }
    if (url.pathname.endsWith('/subscribed_apps')) return json({ success: true });
    return json({ error: { message: 'unexpected', code: 100 } }, 400);
  });
}

function enable() {
  vi.stubEnv('INSTAGRAM_ENABLED', 'true');
  vi.stubEnv('INSTAGRAM_APP_ID', '1234567890');
  vi.stubEnv('INSTAGRAM_APP_SECRET', 'test-only-ig-secret');
  vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'test-only-verify');
  vi.stubEnv('APP_URL', 'https://app.example.test');
  vi.stubEnv('INSTAGRAM_PAGE_LOGIN_ENABLED', 'true');
  vi.stubEnv('META_APP_ID', '9876543210');
  vi.stubEnv('META_APP_SECRET', FB_SECRET);
}

const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof InstagramError ? e.code : String(e)));
const goodState = (over: Partial<Parameters<typeof signPageLoginState>[1]> = {}) =>
  signPageLoginState(FB_SECRET, { nonce: NONCE, accountId: ACCOUNT, userId: USER, expiresAt: Date.now() + PAGE_LOGIN_TTL_MS, ...over });

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('INSTAGRAM_ENABLED', '');
  for (const fn of Object.values(conn)) fn.mockReset();
  conn.ownerOf.mockResolvedValue(null);
  conn.asWorker.mockImplementation(async (_account: string, work: (tx: unknown) => unknown) => work({}));
  conn.requireEntitled.mockResolvedValue(undefined);
  conn.requireRoomUnlessHeld.mockResolvedValue(undefined);
  conn.saveConnection.mockResolvedValue('44444444-4444-4444-8444-444444444444');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('while the Page login is off', () => {
  it('refuses every step before any database or Meta work, even with Instagram itself on', async () => {
    enable();
    vi.stubEnv('INSTAGRAM_PAGE_LOGIN_ENABLED', '');
    expect(await codeOf(startPageLogin(admin))).toBe('instagram_not_enabled');
    expect(await codeOf(completePageLogin(admin, { state: NONCE, cookieState: goodState(), code: 'abc' }))).toBe('instagram_not_enabled');
    expect(await codeOf(listPageAccounts(admin, 'x'))).toBe('instagram_not_enabled');
    expect(await codeOf(connectPageAccount(admin, { pickCookie: 'x', instagramUserId: '17841400000000001' }))).toBe('instagram_not_enabled');
    expect(fetchMock).not.toHaveBeenCalled();
    for (const fn of Object.values(conn)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('when enabled', () => {
  beforeEach(enable);

  it('lets only admins start, finish, list or connect', async () => {
    const agent = { ...admin, role: 'agent' as const };
    expect(await codeOf(startPageLogin(agent))).toBe('forbidden');
    expect(await codeOf(completePageLogin(agent, { state: NONCE, cookieState: goodState(), code: 'abc' }))).toBe('forbidden');
    expect(await codeOf(listPageAccounts(agent, 'x'))).toBe('forbidden');
    expect(await codeOf(connectPageAccount(agent, { pickCookie: 'x', instagramUserId: '1' }))).toBe('forbidden');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts with the Facebook dialog, the Page scopes and a state bound to the admin and workspace', async () => {
    const { url, stateCookie } = await startPageLogin(admin);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toMatch(/^https:\/\/www\.facebook\.com\/v\d+\.\d+\/dialog\/oauth$/);
    expect(parsed.searchParams.get('client_id')).toBe('9876543210');
    expect(parsed.searchParams.get('scope')).toContain('pages_messaging');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.example.test/api/instagram/page-login/callback');
    const state = readPageLoginState(FB_SECRET, stateCookie);
    expect(state).toMatchObject({ accountId: ACCOUNT, userId: USER });
    expect(parsed.searchParams.get('state')).toBe(state?.nonce);
    expect(conn.requireEntitled).toHaveBeenCalledWith(ACCOUNT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('state cookie', () => {
    it('round-trips and refuses tampering, another secret and an Instagram Login state cookie', () => {
      const cookie = goodState();
      expect(readPageLoginState(FB_SECRET, cookie)).toMatchObject({ nonce: NONCE, accountId: ACCOUNT, userId: USER });
      expect(readPageLoginState('other-secret', cookie)).toBeNull();
      const [, mac] = cookie.split('.');
      const forged = Buffer.from(JSON.stringify({ n: NONCE, a: OTHER, u: USER, e: Date.now() + 1000 })).toString('base64url');
      expect(readPageLoginState(FB_SECRET, `${forged}.${mac}`)).toBeNull();
      expect(readPageLoginState(FB_SECRET, null)).toBeNull();
      // Same secret, different purpose: an Instagram Login state can never complete a Page login.
      const igCookie = signInstagramState(FB_SECRET, { nonce: NONCE, accountId: ACCOUNT, userId: USER, expiresAt: Date.now() + 1000, comments: false });
      expect(readPageLoginState(FB_SECRET, igCookie)).toBeNull();
    });

    it('refuses a missing, foreign, expired or mismatched state before any Meta call', async () => {
      const cases: { state: string | null; cookieState: string | null }[] = [
        { state: NONCE, cookieState: null },
        { state: null, cookieState: goodState() },
        { state: 'm'.repeat(32), cookieState: goodState() },
        { state: NONCE, cookieState: goodState({ accountId: OTHER }) },
        { state: NONCE, cookieState: goodState({ userId: OTHER }) },
        { state: NONCE, cookieState: goodState({ expiresAt: Date.now() - 1 }) },
        { state: NONCE, cookieState: signPageLoginState('another-secret', { nonce: NONCE, accountId: ACCOUNT, userId: USER, expiresAt: Date.now() + 1000 }) },
      ];
      for (const input of cases) expect(await codeOf(completePageLogin(admin, { ...input, code: 'abc' }))).toBe('state_mismatch');
      for (const code of [null, '', 'a b', 'x'.repeat(2049)])
        expect(await codeOf(completePageLogin(admin, { state: NONCE, cookieState: goodState(), code }))).toBe('invalid_request');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('permissions', () => {
    it('records the Facebook grant as the scopes every feature gate reads', () => {
      expect(scopesFromPermissions(ALL_PERMISSIONS)).toEqual(['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments']);
      expect(scopesFromPermissions(ALL_PERMISSIONS.filter((p) => p !== 'instagram_manage_comments')))
        .toEqual(['instagram_business_basic', 'instagram_business_manage_messages']);
      expect(scopesFromPermissions(ALL_PERMISSIONS.filter((p) => p !== 'pages_messaging'))).toEqual([]);
      expect(scopesFromPermissions([])).toEqual([]);
    });

    it('refuses a grant without the message permissions and issues no pick cookie', async () => {
      meta(ALL_PERMISSIONS.filter((p) => p !== 'instagram_manage_messages'));
      expect(await codeOf(completePageLogin(admin, { state: NONCE, cookieState: goodState(), code: 'abc' }))).toBe('instagram_permission_missing');
    });
  });

  describe('callback', () => {
    it('exchanges the code, checks the grant and seals the long-lived user token for this admin only', async () => {
      meta();
      const { pickCookie } = await completePageLogin(admin, { state: NONCE, cookieState: goodState(), code: 'abc123' });
      expect(urls().map((u) => new URL(u).pathname.split('/').pop())).toEqual(['access_token', 'access_token', 'permissions']);
      // The sealed value is ciphertext: neither token appears in it.
      expect(pickCookie).not.toContain(LONG);
      expect(pickCookie).not.toContain(SHORT);
      expect(openPick(admin, pickCookie)?.userToken).toBe(LONG);
      expect(openPick(admin, pickCookie)?.scopes).toContain('instagram_business_manage_comments');
      // Bound to the admin and workspace; expires; tampering fails the authenticated decrypt.
      expect(openPick({ ...admin, userId: OTHER }, pickCookie)).toBeNull();
      expect(openPick({ ...admin, accountId: OTHER }, pickCookie)).toBeNull();
      expect(openPick(admin, pickCookie, Date.now() + PAGE_LOGIN_TTL_MS + 5_000)).toBeNull();
      expect(openPick(admin, `${pickCookie.slice(0, -2)}00`)).toBeNull();
      expect(openPick(admin, null)).toBeNull();
      expect(openPick(admin, 'x'.repeat(4000))).toBeNull();
    });

    it('maps a Meta failure to a fixed code without Meta text', async () => {
      fetchMock.mockResolvedValue(json({ error: { message: 'secret detail EAAG-leak', code: 190 } }, 400));
      const error = await completePageLogin(admin, { state: NONCE, cookieState: goodState(), code: 'abc' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InstagramError);
      expect((error as InstagramError).code).toBe('instagram_token_invalid');
      expect(String((error as Error).message)).not.toContain('EAAG-leak');
    });
  });

  describe('choose and connect', () => {
    const pick = () => sealPick({ accountId: ACCOUNT, userId: USER, expiresAt: Date.now() + 60_000, userToken: LONG, scopes: scopesFromPermissions(ALL_PERMISSIONS) });

    it('lists only Pages that link an Instagram account, with ids and names and no token', async () => {
      meta();
      const accounts = await listPageAccounts(admin, pick());
      expect(accounts).toEqual([{ instagramUserId: '17841400000000001', username: 'shop', pageId: '501', pageName: 'Shop Page' }]);
      expect(JSON.stringify(accounts)).not.toMatch(/EAAG/);
      expect(await codeOf(listPageAccounts(admin, null))).toBe('state_mismatch');
      expect(await codeOf(listPageAccounts({ ...admin, userId: OTHER }, pick()))).toBe('state_mismatch');
    });

    it('connects the account Meta lists, with the Page token from Meta and the Page webhook subscription', async () => {
      meta();
      const result = await connectPageAccount(admin, { pickCookie: pick(), instagramUserId: '17841400000000001' });
      expect(result.instagramAccountId).toBe('44444444-4444-4444-8444-444444444444');
      const subscribe = fetchMock.mock.calls.find(([url]) => String(url).includes('/subscribed_apps'))!;
      expect(String(subscribe[0])).toContain('/501/subscribed_apps');
      expect((subscribe[1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${PAGE_TOKEN}` });
      const save = conn.saveConnection.mock.calls[0];
      expect(save[0]).toEqual(admin);
      expect(save[1]).toMatchObject({
        kind: 'facebook_page', facebookPageId: '501', token: PAGE_TOKEN, status: 'active', subscribed: true,
        me: { userId: '17841400000000001', username: 'shop' },
      });
      expect(save[1].scopes).toContain('instagram_business_manage_messages');
      expect(save[1].expiresAt.getTime()).toBeGreaterThan(Date.now() + 5 * 365 * 24 * 3600_000);
      expect(JSON.stringify(result)).not.toMatch(/EAAG/);
    });

    it('refuses an account the person\'s Pages do not link, a malformed id, a stale cookie, and subscribes nothing', async () => {
      meta();
      expect(await codeOf(connectPageAccount(admin, { pickCookie: pick(), instagramUserId: '17841499999999999' }))).toBe('not_found');
      expect(await codeOf(connectPageAccount(admin, { pickCookie: pick(), instagramUserId: '1; DROP' }))).toBe('invalid_request');
      expect(await codeOf(connectPageAccount(admin, { pickCookie: null, instagramUserId: '17841400000000001' }))).toBe('state_mismatch');
      expect(urls().some((u) => u.includes('subscribed_apps'))).toBe(false);
      expect(conn.saveConnection).not.toHaveBeenCalled();
    });

    it('refuses an Instagram account another workspace holds, before subscribing', async () => {
      meta();
      conn.ownerOf.mockResolvedValue(OTHER);
      expect(await codeOf(connectPageAccount(admin, { pickCookie: pick(), instagramUserId: '17841400000000001' }))).toBe('account_in_use');
      expect(urls().some((u) => u.includes('subscribed_apps'))).toBe(false);
      expect(conn.saveConnection).not.toHaveBeenCalled();
    });
  });

  it('probes a Page link for health and treats a Page that links nothing as no account', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: '501', instagram_business_account: { id: '17841400000000001' } }));
    expect(await probePageLink('501', PAGE_TOKEN)).toBe('17841400000000001');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${PAGE_TOKEN}` });
    expect(String(fetchMock.mock.calls[0][0])).not.toContain(PAGE_TOKEN);
    fetchMock.mockResolvedValueOnce(json({ id: '501' }));
    expect(await probePageLink('501', PAGE_TOKEN)).toBeNull();
    expect(await codeOf(probePageLink('5/../x', PAGE_TOKEN))).toBe('invalid_request');
  });
});
