// Stage 4E: an account connected through a Facebook Page (connection_kind
// 'facebook_page') is reached through its Page, not Instagram Login. Health probes
// the Page link instead of /me, the token sweep never refreshes its (Page) token,
// resubscribe leaves it alone, disconnect removes the Page subscription, and the
// view carries the kind and Page id but never a token.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '@/lib/whatsapp/encryption';

const graph = vi.hoisted(() => ({ getMe: vi.fn(), refreshToken: vi.fn(), unsubscribe: vi.fn(), unsubscribePage: vi.fn() }));
const db = vi.hoisted(() => ({ withTenant: vi.fn(), rows: {} as Record<string, unknown[]>, executed: [] as unknown[][], queried: [] as string[] }));

vi.mock('./graph', async (original) => ({ ...(await original<typeof import('./graph')>()), ...graph }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: db.withTenant }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/payments/ledger', () => ({ auditTx: vi.fn() }));

import { disconnect, toView } from './connection';
import { checkHealth } from './health';
import { runResubscribe } from './resubscribe';
import { resetInstagramScheduleForTests, sweepInstagramTokens } from './token-sweep';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const IG = '44444444-4444-4444-8444-444444444444';
const IG_USER = '17841400000000001';
const PAGE_TOKEN = 'EAAG-test-only-page-token';
const SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'];

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function secretRow(kind: 'instagram_login' | 'facebook_page', over: Record<string, unknown> = {}) {
  return {
    id: IG, ig_user_id: IG_USER, status: 'active', access_token_enc: encrypt(PAGE_TOKEN), scopes: SCOPES,
    connection_kind: kind, facebook_page_id: kind === 'facebook_page' ? '501' : null, ...over,
  };
}

function route(rows: Record<string, unknown[]>) {
  db.rows = rows;
  db.withTenant.mockImplementation(async (_ctx: unknown, work: (tx: unknown) => unknown) => work({
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?').replace(/\s+/g, ' ');
      db.queried.push(sql);
      if (/SELECT scopes FROM/.test(sql)) return [{ scopes: SCOPES }];
      if (/SELECT status, access_token_enc, username/.test(sql)) return [{ status: 'active', access_token_enc: (db.rows.secret[0] as { access_token_enc: string }).access_token_enc, username: 'shop' }];
      if (/crm_instagram_owner_account/.test(sql)) return [{ owner: null }];
      if (/token_refreshed_at, token_expires_at/.test(sql)) return db.rows.sweep ?? [];
      if (/AND status='active'/.test(sql) && /ig_user_id, access_token_enc, scopes/.test(sql)) return db.rows.resubscribe ?? [];
      return db.rows.secret;
    },
    $executeRaw: async (...args: unknown[]) => { db.executed.push(args); return 1; },
  }));
}

function enable() {
  vi.stubEnv('INSTAGRAM_ENABLED', 'true');
  vi.stubEnv('INSTAGRAM_APP_ID', '1234567890');
  vi.stubEnv('INSTAGRAM_APP_SECRET', 'test-only-ig-secret');
  vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'test-only-verify');
  vi.stubEnv('APP_URL', 'https://app.example.test');
}

beforeEach(() => {
  vi.unstubAllEnvs();
  enable();
  for (const fn of Object.values(graph)) fn.mockReset();
  graph.unsubscribePage.mockResolvedValue(undefined);
  graph.unsubscribe.mockResolvedValue(undefined);
  db.withTenant.mockReset();
  db.executed = [];
  db.queried = [];
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  resetInstagramScheduleForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('view', () => {
  const base = {
    id: IG, ig_user_id: IG_USER, username: 'shop', name: 'Shop', status: 'active' as const, scopes: SCOPES, token_expires_at: null,
    last_webhook_at: null, last_error_code: null, unsupported_event_count: 0, unsupported_event_last_at: null, connected_at: null,
    disconnected_at: null,
  };

  it('carries the kind and the Page id, defaults old rows to instagram_login, and never a token', () => {
    expect(toView(base)).toMatchObject({ connectionKind: 'instagram_login', facebookPageId: null });
    const page = toView({ ...base, connection_kind: 'facebook_page', facebook_page_id: '501', access_token_enc: 'sealed' } as typeof base);
    expect(page).toMatchObject({ connectionKind: 'facebook_page', facebookPageId: '501' });
    expect(JSON.stringify(page)).not.toContain('sealed');
    // A Page id on an Instagram Login row is never shown.
    expect(toView({ ...base, connection_kind: 'instagram_login', facebook_page_id: '501' }).facebookPageId).toBeNull();
  });
});

describe('health', () => {
  it('probes the Page link, not Instagram Login /me, for a Page connection', async () => {
    route({ secret: [secretRow('facebook_page')] });
    fetchMock.mockResolvedValue(json({ id: '501', instagram_business_account: { id: IG_USER } }));
    expect(await checkHealth(ACCOUNT, IG)).toBe('active');
    expect(graph.getMe).not.toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain('graph.facebook.com');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/501');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain(PAGE_TOKEN);
  });

  it('marks the token invalid when the Page no longer links this Instagram account', async () => {
    route({ secret: [secretRow('facebook_page')] });
    fetchMock.mockResolvedValue(json({ id: '501', instagram_business_account: { id: '17841499999999999' } }));
    expect(await checkHealth(ACCOUNT, IG)).toBe('token_invalid');
  });

  it('keeps using /me for an Instagram Login account', async () => {
    route({ secret: [secretRow('instagram_login')] });
    graph.getMe.mockResolvedValue({ userId: IG_USER, username: 'shop', name: null });
    expect(await checkHealth(ACCOUNT, IG)).toBe('active');
    expect(graph.getMe).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('background jobs', () => {
  it('the token sweep never refreshes a Page token through Instagram Login, even when it is due', async () => {
    const due = { id: IG, status: 'active', access_token_enc: encrypt(PAGE_TOKEN), token_refreshed_at: new Date(0), token_expires_at: new Date(Date.now() + 3600_000), connection_kind: 'facebook_page' };
    route({ secret: [secretRow('facebook_page')], sweep: [due] });
    fetchMock.mockResolvedValue(json({ id: '501', instagram_business_account: { id: IG_USER } }));
    const summary = await sweepInstagramTokens(ACCOUNT);
    expect(graph.refreshToken).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ refreshed: 0, checked: 1, failures: 0 });
  });

  it('resubscribe selects Instagram Login accounts only', async () => {
    route({ secret: [], resubscribe: [] });
    await runResubscribe(ACCOUNT);
    expect(db.queried.join('\n')).toContain("connection_kind='instagram_login'");
  });
});

describe('disconnect', () => {
  const admin = { accountId: ACCOUNT, userId: USER, role: 'admin' as const };

  it('removes the Page subscription for a Page connection and the account subscription otherwise', async () => {
    route({ secret: [secretRow('facebook_page')] });
    await disconnect(admin, IG).catch(() => undefined);
    expect(graph.unsubscribePage).toHaveBeenCalledWith('501', PAGE_TOKEN);
    expect(graph.unsubscribe).not.toHaveBeenCalled();

    graph.unsubscribePage.mockClear();
    route({ secret: [secretRow('instagram_login')] });
    await disconnect(admin, IG).catch(() => undefined);
    expect(graph.unsubscribe).toHaveBeenCalledWith(IG_USER, PAGE_TOKEN);
    expect(graph.unsubscribePage).not.toHaveBeenCalled();
  });
});
