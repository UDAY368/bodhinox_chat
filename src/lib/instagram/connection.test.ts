// Phase 11 T2: connection guards that need no database. While Instagram is
// off nothing reaches Instagram or the database; a bad or foreign state cookie
// is refused before any code exchange; views never carry a token.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const graph = vi.hoisted(() => ({
  exchangeCode: vi.fn(), exchangeLongLived: vi.fn(), getMe: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
}));
const db = vi.hoisted(() => ({ withTenant: vi.fn() }));

vi.mock('./graph', async (original) => ({ ...(await original<typeof import('./graph')>()), ...graph }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: db.withTenant }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));

import {
  disconnect, finishConnect, INSTAGRAM_STATE_TTL_MS, readInstagramState, signInstagramState, startConnect, toView,
} from './connection';
import { InstagramError } from './errors';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '33333333-3333-4333-8333-333333333333';
const USER = '22222222-2222-4222-8222-222222222222';
const admin = { accountId: ACCOUNT, userId: USER, role: 'admin' as const };
const SECRET = 'test-only-ig-secret';
const NONCE = 'n'.repeat(32);

function enable() {
  vi.stubEnv('INSTAGRAM_ENABLED', 'true');
  vi.stubEnv('INSTAGRAM_APP_ID', '1234567890');
  vi.stubEnv('INSTAGRAM_APP_SECRET', SECRET);
  vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'test-only-verify');
  vi.stubEnv('APP_URL', 'https://app.example.test');
}

const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof InstagramError ? e.code : String(e)));

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('INSTAGRAM_ENABLED', '');
  for (const fn of Object.values(graph)) fn.mockReset();
  db.withTenant.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('while Instagram is off', () => {
  it('refuses connect, callback and disconnect before any database or Instagram work', async () => {
    expect(await codeOf(startConnect(admin))).toBe('instagram_not_enabled');
    expect(await codeOf(finishConnect(admin, { state: NONCE, cookieState: 'x', code: 'abc' }))).toBe('instagram_not_enabled');
    expect(await codeOf(disconnect(admin, ACCOUNT))).toBe('instagram_not_enabled');
    expect(db.withTenant).not.toHaveBeenCalled();
    for (const fn of Object.values(graph)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('state cookie', () => {
  const state = { nonce: NONCE, accountId: ACCOUNT, userId: USER, expiresAt: Date.now() + 60_000, comments: true };

  it('round-trips and refuses tampering, another secret and malformed values', () => {
    const cookie = signInstagramState(SECRET, state);
    expect(readInstagramState(SECRET, cookie)).toEqual(state);
    expect(readInstagramState('other-secret', cookie)).toBeNull();
    const [body, mac] = cookie.split('.');
    const forged = Buffer.from(JSON.stringify({ n: NONCE, a: OTHER_ACCOUNT, u: USER, e: state.expiresAt, c: 1 })).toString('base64url');
    expect(readInstagramState(SECRET, `${forged}.${mac}`)).toBeNull();
    expect(readInstagramState(SECRET, `${body}.${mac}.x`)).toBeNull();
    expect(readInstagramState(SECRET, null)).toBeNull();
    expect(readInstagramState(SECRET, 'x'.repeat(3000))).toBeNull();
  });
});

describe('when enabled', () => {
  beforeEach(enable);

  it('lets only admins start or finish a connection', async () => {
    const agent = { ...admin, role: 'agent' as const };
    expect(await codeOf(startConnect(agent))).toBe('forbidden');
    expect(await codeOf(finishConnect(agent, { state: NONCE, cookieState: null, code: 'abc' }))).toBe('forbidden');
    expect(db.withTenant).not.toHaveBeenCalled();
  });

  it('refuses a missing, foreign, expired or mismatched state before exchanging the code', async () => {
    const good = { nonce: NONCE, accountId: ACCOUNT, userId: USER, expiresAt: Date.now() + INSTAGRAM_STATE_TTL_MS, comments: false };
    const cases: { state: string | null; cookieState: string | null }[] = [
      { state: NONCE, cookieState: null },
      { state: null, cookieState: signInstagramState(SECRET, good) },
      { state: 'm'.repeat(32), cookieState: signInstagramState(SECRET, good) },
      { state: NONCE, cookieState: signInstagramState(SECRET, { ...good, accountId: OTHER_ACCOUNT }) },
      { state: NONCE, cookieState: signInstagramState(SECRET, { ...good, userId: OTHER_ACCOUNT }) },
      { state: NONCE, cookieState: signInstagramState(SECRET, { ...good, expiresAt: Date.now() - 1 }) },
      { state: NONCE, cookieState: signInstagramState('another-secret', good) },
    ];
    for (const input of cases) expect(await codeOf(finishConnect(admin, { ...input, code: 'abc' }))).toBe('state_mismatch');
    expect(graph.exchangeCode).not.toHaveBeenCalled();
    expect(db.withTenant).not.toHaveBeenCalled();
  });

  it('refuses a malformed code after a valid state, still without an exchange', async () => {
    const cookieState = signInstagramState(SECRET,
      { nonce: NONCE, accountId: ACCOUNT, userId: USER, expiresAt: Date.now() + 60_000, comments: false });
    for (const code of [null, '', 'a b', 'x'.repeat(2049)])
      expect(await codeOf(finishConnect(admin, { state: NONCE, cookieState, code }))).toBe('invalid_request');
    expect(graph.exchangeCode).not.toHaveBeenCalled();
  });

  it('refuses a disconnect of a malformed id without a lookup', async () => {
    expect(await codeOf(disconnect(admin, 'not-a-uuid'))).toBe('not_found');
    expect(db.withTenant).not.toHaveBeenCalled();
  });
});

describe('account view', () => {
  const row: Parameters<typeof toView>[0] = {
    id: 'a', ig_user_id: '17841400000000000', username: 'shop', name: 'Shop', status: 'active',
    scopes: ['instagram_business_basic', 'instagram_business_manage_messages'],
    token_expires_at: new Date('2026-12-01T00:00:00Z'), last_webhook_at: null, last_error_code: null,
    unsupported_event_count: 2, unsupported_event_last_at: null, connected_at: new Date('2026-11-01T00:00:00Z'),
    disconnected_at: null,
  };

  it('never carries a token and lists the scopes each feature still needs', () => {
    // An over-wide row must still not leak the token through the view.
    const view = toView({ ...row, access_token_enc: 'test-only-encrypted' } as typeof row);
    expect(JSON.stringify(view)).not.toContain('test-only-encrypted');
    expect(view.missingScopes).toEqual({ dm: [], comments: ['instagram_business_manage_comments'] });
    expect(view.accessExpiresAt).toBe('2026-12-01T00:00:00.000Z');
    expect(view.unsupportedEventCount).toBe(2);
  });

  it('hides the expiry of a disconnected account', () => {
    expect(toView({ ...row, status: 'disconnected' }).accessExpiresAt).toBeNull();
  });
});
