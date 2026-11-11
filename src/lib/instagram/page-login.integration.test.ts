// Stage 4E on a real PostgreSQL: connecting an Instagram account through a Facebook
// Page. Meta's answers are documented-shape fixtures (fetch is stubbed: no request
// leaves the test). Covers the connect upsert (kind, Page id, encrypted Page token,
// subscription), the token staying out of the app role's view, the kind/Page checks,
// another workspace's live account being refused before any subscription, switching
// kinds on reconnect, disconnect removing the Page subscription, and the
// admin-only rule.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';

import { disconnect, listInstagramAccounts, saveConnection } from './connection';
import { InstagramError } from './errors';
import { connectPageAccount, scopesFromPermissions, sealPick } from './page-login';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const PAGE_TOKEN = 'EAAG-test-only-page-token';
const USER_TOKEN = 'EAAG-test-only-user-token';
const PERMISSIONS = ['pages_show_list', 'pages_messaging', 'instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments'];
const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const seed = String(Date.now()).slice(-9);
const igUser = `65${seed}`, pageId = `75${seed}`;
let owner: pg.Client;

const actor = (role: 'admin' | 'agent') => ({ accountId: accountA, userId: role === 'admin' ? adminA : agentA, role });
const pickFor = (role: 'admin' | 'agent' = 'admin') => sealPick({
  accountId: accountA, userId: actor(role).userId, expiresAt: Date.now() + 60_000, userToken: USER_TOKEN, scopes: scopesFromPermissions(PERMISSIONS),
});
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof InstagramError ? e.code : String(e)));
const pgCode = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? 'error');

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function meta() {
  fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/me/accounts')) {
      return json({ data: [{ id: pageId, name: 'Shop Page', access_token: PAGE_TOKEN, instagram_business_account: { id: igUser, username: 'shoppage' } }] });
    }
    if (url.pathname.endsWith('/subscribed_apps')) return json({ success: true });
    return json({ error: { message: `unexpected ${init?.method ?? 'GET'}`, code: 100 } }, 400);
  });
}
const subscriptionCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/subscribed_apps'));

const row = async () => (await owner.query(
  `SELECT status, access_token_enc, scopes, connection_kind, facebook_page_id, webhook_subscribed_at, token_expires_at
   FROM instagram_accounts WHERE account_id=$1 AND ig_user_id=$2`, [accountA, igUser])).rows[0];

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

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Facebook Page login on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'IG test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[ownerA, adminA, agentA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'PL A',$2),($3,'PL B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner')`,
      [accountA, ownerA, adminA, agentA, accountB, ownerB]);
  });
  beforeEach(() => {
    vi.unstubAllEnvs();
    enable();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, adminA, agentA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('only an admin connects; an agent is refused before any Meta call', async () => {
    meta();
    expect(await codeOf(connectPageAccount(actor('agent'), { pickCookie: pickFor('agent'), instagramUserId: igUser }))).toBe('forbidden');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('connects through the Page: kind, Page id, encrypted Page token, subscription and a far expiry', async () => {
    meta();
    const { instagramAccountId } = await connectPageAccount(actor('admin'), { pickCookie: pickFor(), instagramUserId: igUser });
    const stored = await row();
    expect(stored).toMatchObject({ status: 'active', connection_kind: 'facebook_page', facebook_page_id: pageId });
    expect(stored.access_token_enc).not.toContain(PAGE_TOKEN);
    expect(decrypt(stored.access_token_enc)).toBe(PAGE_TOKEN);
    expect(stored.scopes).toContain('instagram_business_manage_messages');
    expect(stored.webhook_subscribed_at).not.toBeNull();
    expect(stored.token_expires_at.getTime()).toBeGreaterThan(Date.now() + 5 * 365 * 24 * 3600_000);
    expect(subscriptionCalls()).toHaveLength(1);
    const audit = (await owner.query("SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='instagram.connect' AND resource_id=$2", [accountA, instagramAccountId])).rows;
    expect(JSON.stringify(audit)).not.toContain('EAAG');
  });

  it('the member view carries the kind and Page id but no token', async () => {
    const views = await listInstagramAccounts(actor('agent'));
    const view = views.find((v) => v.igUserId === igUser)!;
    expect(view).toMatchObject({ connectionKind: 'facebook_page', facebookPageId: pageId });
    expect(JSON.stringify(views)).not.toMatch(/EAAG|access_token/);
  });

  it('the kind and Page checks refuse an inconsistent row', async () => {
    const insert = (kind: string, page: string | null) => owner.query(
      `INSERT INTO instagram_accounts(account_id,ig_user_id,access_token_enc,scopes,connected_by_user_id,connection_kind,facebook_page_id)
       VALUES($1,$2,$3,'{}',$4,$5,$6)`, [accountA, `66${seed}${kind.length}${page ? 1 : 0}`, encrypt('x'), ownerA, kind, page]);
    expect(await pgCode(insert('facebook_page', null))).toBe('23514');
    expect(await pgCode(insert('instagram_login', pageId))).toBe('23514');
    expect(await pgCode(insert('page', pageId))).toBe('23514');
  });

  it('another workspace cannot take the account while it is held live, and nothing is subscribed', async () => {
    meta();
    const asB = { accountId: accountB, userId: ownerB, role: 'owner' as const };
    const pick = sealPick({ accountId: accountB, userId: ownerB, expiresAt: Date.now() + 60_000, userToken: USER_TOKEN, scopes: scopesFromPermissions(PERMISSIONS) });
    expect(await codeOf(connectPageAccount(asB, { pickCookie: pick, instagramUserId: igUser }))).toBe('account_in_use');
    expect(subscriptionCalls()).toHaveLength(0);
    expect((await owner.query('SELECT count(*)::int AS n FROM instagram_accounts WHERE account_id=$1', [accountB])).rows[0].n).toBe(0);
  });

  it('a pick sealed for another admin or workspace is refused', async () => {
    meta();
    expect(await codeOf(connectPageAccount(actor('admin'), { pickCookie: pickFor('agent'), instagramUserId: igUser }))).toBe('state_mismatch');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reconnecting through Instagram Login switches the row back consistently', async () => {
    await saveConnection(actor('admin'), {
      me: { userId: igUser, username: 'shoppage', name: null }, token: 'IGAA-test-only-token', expiresAt: new Date(Date.now() + 60 * 24 * 3600_000),
      scopes: ['instagram_business_basic', 'instagram_business_manage_messages'], status: 'active', subscribed: true,
      kind: 'instagram_login', facebookPageId: null, release: async () => undefined,
    });
    expect(await row()).toMatchObject({ connection_kind: 'instagram_login', facebook_page_id: null });
    // ... and through the Page again.
    meta();
    await connectPageAccount(actor('admin'), { pickCookie: pickFor(), instagramUserId: igUser });
    expect(await row()).toMatchObject({ connection_kind: 'facebook_page', facebook_page_id: pageId });
  });

  it('disconnect removes the Page subscription, clears the token and keeps the kind', async () => {
    meta();
    fetchMock.mockClear();
    const id = (await owner.query('SELECT id FROM instagram_accounts WHERE account_id=$1 AND ig_user_id=$2', [accountA, igUser])).rows[0].id;
    const view = await disconnect(actor('admin'), id);
    expect(view.status).toBe('disconnected');
    const [url, init] = subscriptionCalls()[0] as [string, RequestInit];
    expect(url).toContain(`/${pageId}/subscribed_apps`);
    expect(init.method).toBe('DELETE');
    expect(await row()).toMatchObject({ status: 'disconnected', access_token_enc: null, connection_kind: 'facebook_page', facebook_page_id: pageId });
  });
});
