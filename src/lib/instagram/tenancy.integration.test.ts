// Phase 11 T2 on a real PostgreSQL: tenancy of the Instagram tables and the
// connection, health, token-sweep and comment-rule services. Instagram's Graph
// API is mocked: no request ever leaves the test.
//   - workspace A cannot read B's accounts, identities, comment rules/events or links
//   - the app role cannot select the token column and cannot write accounts
//   - the resolver functions run only as the worker
//   - composite FKs refuse cross-tenant references
//   - connect upserts, reconnect reuses the row, another workspace's live account is refused
//   - plan room: a held (e.g. token_invalid) account reconnects at the limit; a new one is refused;
//     a lost room race keeps a subscription another workspace now relies on
//   - disconnect clears the token and keeps conversations
//   - health: 190 -> token_invalid with one notification per owner/admin; a reconnect meanwhile wins
//   - sweep: refreshes a due token; only workspaces with a live account are queued
//   - comment rules: admin CRUD through RLS, permission gap and foreign ids refused
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { MetaApiError } from '@/lib/whatsapp/meta-api';

const graph = vi.hoisted(() => ({
  exchangeCode: vi.fn(), exchangeLongLived: vi.fn(), getMe: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), refreshToken: vi.fn(),
  listMedia: vi.fn(),
}));
vi.mock('@/lib/instagram/graph', async (original) => ({ ...(await original<typeof import('@/lib/instagram/graph')>()), ...graph }));

import { disconnect, finishConnect, listInstagramAccounts, signInstagramState } from './connection';
import { checkHealth } from './health';
import { resetInstagramScheduleForTests, scheduleInstagramSweeps, sweepInstagramTokens } from './token-sweep';
import { createCommentRule, deleteCommentRule, listCommentRules, listRecentPosts, updateCommentRule } from './comment-rules';
import { InstagramError } from './errors';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const SECRET = 'test-only-ig-secret';
const DM = ['instagram_business_basic', 'instagram_business_manage_messages'];
const ALL = [...DM, 'instagram_business_manage_comments'];
const accountA = randomUUID(), accountB = randomUUID(), accountC = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID(), ownerC = randomUUID();
const seed = String(Date.now()).slice(-9);
const igUserA = `61${seed}`, igUserB = `62${seed}`, igUserNew = `63${seed}`;
let owner: pg.Client;
let igA = '', igB = '', igNoComments = '', contactA = '', contactB = '', identityB = '';

const actor = (role: 'owner' | 'admin' | 'agent', userId = role === 'agent' ? agentA : adminA) =>
  ({ accountId: accountA, userId, role });
const asA: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) =>
  e instanceof InstagramError ? e.code : (e as { code?: string; meta?: { code?: string } }).meta?.code ?? (e as { code?: string }).code ?? String(e));
const pgCode = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string; meta?: { code?: string } }) => {
  const text = String((e as Error).message ?? '');
  return e.meta?.code ?? (/permission denied/.test(text) ? '42501' : /foreign key/.test(text) ? '23503' : e.code ?? 'error');
});

async function addAccount(accountId: string, userId: string, igUserId: string, scopes: string[], token = 'test-only-ig-token'): Promise<string> {
  return (await owner.query(
    `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id,token_expires_at,token_refreshed_at)
     VALUES($1,$2,'shop',$3,$4,$5,now()+interval '50 days',now()) RETURNING id`,
    [accountId, igUserId, encrypt(token), scopes, userId])).rows[0].id;
}
const accountRow = async (id: string) => (await owner.query(
  'SELECT status, access_token_enc, last_error_code, token_expires_at, disconnected_at FROM instagram_accounts WHERE id=$1', [id])).rows[0];

function enable() {
  vi.stubEnv('INSTAGRAM_ENABLED', 'true');
  vi.stubEnv('INSTAGRAM_APP_ID', '1234567890');
  vi.stubEnv('INSTAGRAM_APP_SECRET', SECRET);
  vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'test-only-verify');
  vi.stubEnv('APP_URL', 'https://app.example.test');
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram tenancy and connection on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    const users = [ownerA, adminA, agentA, ownerB, ownerC];
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'IG test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'IG A',$2),($3,'IG B',$4),($5,'IG C',$6)",
      [accountA, ownerA, accountB, ownerB, accountC, ownerC]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),
      ($5,$6,'owner'),($7,$8,'owner')`, [accountA, ownerA, adminA, agentA, accountB, ownerB, accountC, ownerC]);
    igA = await addAccount(accountA, ownerA, igUserA, ALL);
    igNoComments = await addAccount(accountA, ownerA, `64${seed}`, DM);
    igB = await addAccount(accountB, ownerB, igUserB, ALL);
    contactA = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,'','@a') RETURNING id", [accountA, ownerA])).rows[0].id;
    contactB = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,'','@b') RETURNING id", [accountB, ownerB])).rows[0].id;
    identityB = (await owner.query(`INSERT INTO contact_channel_identities(account_id,contact_id,instagram_account_id,external_id)
      VALUES($1,$2,$3,$4) RETURNING id`, [accountB, contactB, igB, `71${seed}`])).rows[0].id;
    const ruleB = (await owner.query(`INSERT INTO instagram_comment_rules(account_id,instagram_account_id,reply_text)
      VALUES($1,$2,'hi') RETURNING id`, [accountB, igB])).rows[0].id;
    await owner.query(`INSERT INTO instagram_comment_events(account_id,instagram_account_id,comment_id,rule_id)
      VALUES($1,$2,$3,$4)`, [accountB, igB, `81${seed}`, ruleB]);
    await owner.query(`INSERT INTO contact_identity_links(account_id,identity_id,from_contact_id,to_contact_id,kind,decided_by_user_id)
      VALUES($1,$2,$3,$3,'link',$4)`, [accountB, identityB, contactB, ownerB]);
  });
  beforeEach(() => {
    vi.unstubAllEnvs();
    enable();
    for (const fn of Object.values(graph)) fn.mockReset();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (owner) {
      const accounts = [accountA, accountB, accountC];
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [accounts]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [accounts]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, adminA, agentA, ownerB, ownerC]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  describe('tenancy', () => {
    it('workspace A reads none of B’s accounts, identities, rules, events or links', async () => {
      const seen = await withTenant(asA, async (tx) => ({
        accounts: await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM instagram_accounts`,
        identities: await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM contact_channel_identities`,
        rules: await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM instagram_comment_rules`,
        events: await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM instagram_comment_events`,
        links: await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM contact_identity_links`,
      }));
      expect(seen.accounts.map((r) => r.id).sort()).toEqual([igA, igNoComments].sort());
      expect([seen.identities[0].n, seen.rules[0].n, seen.events[0].n, seen.links[0].n]).toEqual([0, 0, 0, 0]);
      const seenB = await withTenant(asB, async (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM contact_identity_links`);
      expect(seenB[0].n).toBe(1);
    });

    it('the app role cannot read the token column or write accounts', async () => {
      expect(await pgCode(withTenant(asA, (tx) => tx.$queryRaw`SELECT access_token_enc FROM instagram_accounts`))).toBe('42501');
      expect(await pgCode(withTenant(asA, (tx) => tx.$executeRaw`UPDATE instagram_accounts SET status='active' WHERE id=${igA}::uuid`)))
        .toBe('42501');
      expect(await pgCode(withTenant(asA, (tx) => tx.$executeRaw`INSERT INTO instagram_accounts(ig_user_id,access_token_enc)
        VALUES(${`65${seed}`}, 'x')`))).toBe('42501');
      // The member view never carries a token.
      const views = await listInstagramAccounts(actor('agent'));
      expect(JSON.stringify(views)).not.toMatch(/token_enc|accessToken|test-only-ig-token/);
      expect(views.find((v) => v.id === igA)?.missingScopes).toEqual({ dm: [], comments: [] });
    });

    it('the resolver functions run only as the worker', async () => {
      for (const sql of [
        `SELECT * FROM crm_resolve_instagram_account('${igUserA}')`,
        `SELECT crm_instagram_owner_account('${igUserA}')`,
        'SELECT * FROM crm_instagram_accounts_for_sweep()',
      ]) expect(await pgCode(withTenant(asA, (tx) => tx.$queryRawUnsafe(sql)))).toBe('42501');
      const resolved = await getWorkerPrisma().$queryRaw<{ account_id: string; instagram_account_id: string }[]>`
        SELECT account_id::text AS account_id, instagram_account_id::text AS instagram_account_id FROM crm_resolve_instagram_account(${igUserB})`;
      expect(resolved).toEqual([{ account_id: accountB, instagram_account_id: igB }]);
      expect(await getWorkerPrisma().$queryRaw`SELECT * FROM crm_resolve_instagram_account('not-a-number')`).toEqual([]);
    });

    it('composite FKs refuse cross-tenant references', async () => {
      const worker = getWorkerPrisma();
      const asWorkerA = <T>(work: Parameters<typeof withTenant<T>>[1]) => withTenant({ accountId: accountA, role: 'owner' }, work, worker);
      expect(await pgCode(asWorkerA((tx) => tx.$executeRaw`INSERT INTO instagram_comment_rules(instagram_account_id,reply_text)
        VALUES(${igB}::uuid,'x')`))).toBe('23503');
      expect(await pgCode(asWorkerA((tx) => tx.$executeRaw`INSERT INTO contact_channel_identities(contact_id,instagram_account_id,external_id)
        VALUES(${contactB}::uuid,${igA}::uuid,'1')`))).toBe('23503');
      expect(await pgCode(asWorkerA((tx) => tx.$executeRaw`INSERT INTO instagram_comment_events(instagram_account_id,comment_id)
        VALUES(${igB}::uuid,'1')`))).toBe('23503');
      expect(await pgCode(asWorkerA((tx) => tx.$executeRaw`INSERT INTO conversations(user_id,contact_id,channel,instagram_account_id)
        VALUES(${ownerA}::uuid,${contactA}::uuid,'instagram',${igB}::uuid)`))).toBe('23503');
    });
  });

  describe('connection', () => {
    const NONCE = 'q'.repeat(32);
    const cookieFor = (userId = adminA) =>
      signInstagramState(SECRET, { nonce: NONCE, accountId: accountA, userId, expiresAt: Date.now() + 60_000, comments: true });
    const meta = (userId: string, token = 'test-only-long') => {
      graph.exchangeCode.mockResolvedValue({ accessToken: 'test-only-short', userId, scopes: ALL });
      graph.exchangeLongLived.mockResolvedValue({ accessToken: token, expiresInSeconds: 5_184_000 });
      graph.getMe.mockResolvedValue({ userId, username: 'newshop', name: 'New shop' });
      graph.subscribe.mockResolvedValue(undefined);
      graph.unsubscribe.mockResolvedValue(undefined);
    };

    it('connects, audits, and a reconnect reuses and reactivates the row', async () => {
      meta(igUserNew);
      const first = await finishConnect(actor('admin'), { state: NONCE, cookieState: cookieFor(), code: 'abc' });
      expect(graph.subscribe).toHaveBeenCalledWith(igUserNew, 'test-only-long', ['messages', 'messaging_postbacks', 'comments']);
      const row = await accountRow(first.instagramAccountId);
      expect(row.status).toBe('active');
      expect(decrypt(row.access_token_enc)).toBe('test-only-long');
      expect((await owner.query("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='instagram.connect' AND resource_id=$2",
        [accountA, first.instagramAccountId])).rows[0].n).toBe(1);

      await disconnect(actor('admin'), first.instagramAccountId);
      meta(igUserNew, 'test-only-long-2');
      const again = await finishConnect(actor('admin'), { state: NONCE, cookieState: cookieFor(), code: 'abc' });
      expect(again.instagramAccountId).toBe(first.instagramAccountId);
      const back = await accountRow(first.instagramAccountId);
      expect([back.status, back.disconnected_at, decrypt(back.access_token_enc)]).toEqual(['active', null, 'test-only-long-2']);
    });

    it('refuses an Instagram account another workspace holds, before subscribing', async () => {
      meta(igUserB);
      expect(await codeOf(finishConnect(actor('admin'), { state: NONCE, cookieState: cookieFor(), code: 'abc' }))).toBe('account_in_use');
      expect(graph.subscribe).not.toHaveBeenCalled();
      expect((await owner.query('SELECT count(*)::int AS n FROM instagram_accounts WHERE ig_user_id=$1', [igUserB])).rows[0].n).toBe(1);
    });

    it('a state cookie of another admin is refused with no exchange', async () => {
      meta(igUserNew);
      expect(await codeOf(finishConnect(actor('admin'), { state: NONCE, cookieState: cookieFor(ownerA), code: 'abc' }))).toBe('state_mismatch');
      expect(graph.exchangeCode).not.toHaveBeenCalled();
    });

    it('disconnect clears the token, keeps conversations, and another workspace’s id is not found', async () => {
      const id = await addAccount(accountA, ownerA, `66${seed}`, DM);
      const conversation = (await owner.query(`INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id)
        VALUES($1,$2,$3,'instagram',$4) RETURNING id`, [accountA, ownerA, contactA, id])).rows[0].id;
      graph.unsubscribe.mockRejectedValue(new MetaApiError('down', { httpStatus: 500 }));
      const view = await disconnect(actor('admin'), id);
      expect(view.status).toBe('disconnected');
      expect(graph.unsubscribe).toHaveBeenCalledTimes(1);
      const row = await accountRow(id);
      expect([row.status, row.access_token_enc, row.token_expires_at]).toEqual(['disconnected', null, null]);
      expect((await owner.query('SELECT count(*)::int AS n FROM conversations WHERE id=$1', [conversation])).rows[0].n).toBe(1);
      expect(await codeOf(disconnect(actor('admin'), igB))).toBe('not_found');
      expect(await codeOf(disconnect(actor('agent'), igA))).toBe('forbidden');
      expect((await accountRow(igB)).status).toBe('active');
    });
  });

  describe('plan room on connect', () => {
    // A workspace of its own, so its live accounts do not change the sweep expectations below.
    const accountD = randomUUID(), ownerD = randomUUID();
    const plan = `igroom_${seed}`;
    const ownerOfD = { accountId: accountD, userId: ownerD, role: 'owner' as const };
    const cookieD = () =>
      signInstagramState(SECRET, { nonce: 'r'.repeat(32), accountId: accountD, userId: ownerD, expiresAt: Date.now() + 60_000, comments: false });
    const connectD = () => finishConnect(ownerOfD, { state: 'r'.repeat(32), cookieState: cookieD(), code: 'abc' });
    const meta = (userId: string, token = 'test-only-long-d') => {
      graph.exchangeCode.mockResolvedValue({ accessToken: 'test-only-short', userId, scopes: DM });
      graph.exchangeLongLived.mockResolvedValue({ accessToken: token, expiresInSeconds: 5_184_000 });
      graph.getMe.mockResolvedValue({ userId, username: 'dshop', name: null });
      graph.subscribe.mockResolvedValue(undefined);
      graph.unsubscribe.mockResolvedValue(undefined);
    };
    const igD1 = `72${seed}`, igD2 = `73${seed}`, igDNew = `74${seed}`;
    let d1 = '', d2 = '';

    beforeAll(async () => {
      await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'IG test','test-only-hash')",
        [ownerD, `${ownerD}@example.invalid`]);
      await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'IG D',$2)", [accountD, ownerD]);
      await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [accountD, ownerD]);
      await owner.query(`INSERT INTO plans(id,name,features,limits) VALUES($1,'IG room','{"instagram":true}','{"instagram_accounts":2}')`, [plan]);
      await owner.query('INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,$2)', [accountD, plan]);
      d1 = await addAccount(accountD, ownerD, igD1, DM);
      d2 = await addAccount(accountD, ownerD, igD2, DM);
    });
    afterAll(async () => {
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [accountD]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [accountD]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [ownerD]);
      await owner.query('DELETE FROM plans WHERE id=$1', [plan]);
    });

    it('at the limit, a token_invalid account reconnects while a new account is refused before subscribing', async () => {
      await owner.query("UPDATE instagram_accounts SET status='token_invalid', last_error_code='190' WHERE id=$1", [d1]);
      meta(igD1, 'test-only-long-d1');
      const again = await finishConnect(ownerOfD, { state: 'r'.repeat(32), cookieState: cookieD(), code: 'abc' });
      expect(again.instagramAccountId).toBe(d1);
      const row = await accountRow(d1);
      expect([row.status, decrypt(row.access_token_enc)]).toEqual(['active', 'test-only-long-d1']);

      // The reconnect above subscribed once; count only the new account's attempt.
      graph.subscribe.mockClear();
      meta(igDNew);
      expect(await codeOf(connectD())).toBe('limit_reached');
      expect(graph.subscribe).not.toHaveBeenCalled();
      expect((await owner.query('SELECT count(*)::int AS n FROM instagram_accounts WHERE ig_user_id=$1', [igDNew])).rows[0].n).toBe(0);
    });

    it('after losing the last slot during subscribe, keeps the subscription another workspace now relies on', async () => {
      await owner.query("UPDATE instagram_accounts SET status='disconnected', access_token_enc=NULL WHERE id=$1", [d2]);
      const raced = `75${seed}`, contested = `76${seed}`;
      meta(contested);
      graph.subscribe.mockImplementation(async () => {
        // Meanwhile another connect in D fills the slot and workspace B connects the same Instagram account.
        await addAccount(accountD, ownerD, raced, DM);
        await addAccount(accountB, ownerB, contested, DM);
      });
      expect(await codeOf(connectD())).toBe('limit_reached');
      expect(graph.subscribe).toHaveBeenCalledTimes(1);
      expect(graph.unsubscribe).not.toHaveBeenCalled();
      await owner.query("UPDATE instagram_accounts SET status='disconnected', access_token_enc=NULL WHERE ig_user_id=ANY($1::text[])",
        [[raced, contested]]);
    });

    it('after losing the last slot with no other holder, drops its own subscription', async () => {
      const raced = `77${seed}`, lone = `78${seed}`;
      meta(lone, 'test-only-long-lone');
      graph.subscribe.mockImplementation(async () => { await addAccount(accountD, ownerD, raced, DM); });
      expect(await codeOf(connectD())).toBe('limit_reached');
      expect(graph.unsubscribe).toHaveBeenCalledTimes(1);
      expect(graph.unsubscribe).toHaveBeenCalledWith(lone, 'test-only-long-lone');
    });
  });

  describe('health and sweep', () => {
    const notifications = async (id: string) => (await owner.query(
      "SELECT user_id::text AS user_id FROM notifications WHERE instagram_account_id=$1 AND type='instagram_account_health' ORDER BY user_id",
      [id])).rows.map((r: { user_id: string }) => r.user_id);

    it('190 marks the token invalid and notifies each owner/admin once; recovery notifies again', async () => {
      const id = await addAccount(accountA, ownerA, `67${seed}`, DM);
      graph.getMe.mockRejectedValue(new MetaApiError('expired', { httpStatus: 400, code: 190 }));
      expect(await checkHealth(accountA, id)).toBe('token_invalid');
      expect(await checkHealth(accountA, id)).toBe('token_invalid');
      const row = await accountRow(id);
      expect(row.status).toBe('token_invalid');
      expect(row.last_error_code).toMatch(/^190/);
      expect(await notifications(id)).toEqual([ownerA, adminA].sort());

      graph.getMe.mockReset().mockResolvedValue({ userId: `67${seed}`, username: 'shop', name: null });
      expect(await checkHealth(accountA, id)).toBe('active');
      expect((await notifications(id)).length).toBe(4);
    });

    it('a throttle keeps the status; a token for another Instagram account is invalid', async () => {
      const id = await addAccount(accountA, ownerA, `68${seed}`, DM);
      graph.getMe.mockRejectedValue(new MetaApiError('slow down', { httpStatus: 429, code: 4 }));
      expect(await codeOf(checkHealth(accountA, id))).toBe('rate_limited');
      expect((await accountRow(id)).status).toBe('active');
      graph.getMe.mockReset().mockResolvedValue({ userId: '1', username: 'other', name: null });
      expect(await checkHealth(accountA, id)).toBe('token_invalid');
    });

    it('a reconnect during the check wins over the stale result', async () => {
      const id = await addAccount(accountA, ownerA, `69${seed}`, DM);
      graph.getMe.mockImplementation(async () => {
        await owner.query('UPDATE instagram_accounts SET access_token_enc=$1 WHERE id=$2', [encrypt('test-only-fresh'), id]);
        throw new MetaApiError('expired', { httpStatus: 401, code: 190 });
      });
      expect(await checkHealth(accountA, id)).toBe('active');
      expect((await accountRow(id)).status).toBe('active');
      expect(await notifications(id)).toEqual([]);
    });

    it('the sweep refreshes a due token and checks health; nothing runs while off', async () => {
      await owner.query("UPDATE instagram_accounts SET status='disconnected', access_token_enc=NULL WHERE account_id=$1", [accountA]);
      const id = await addAccount(accountA, ownerA, `70${seed}`, DM, 'test-only-old');
      await owner.query("UPDATE instagram_accounts SET token_refreshed_at=now()-interval '30 days', token_expires_at=now()+interval '5 days' WHERE id=$1", [id]);
      graph.refreshToken.mockResolvedValue({ accessToken: 'test-only-refreshed', expiresInSeconds: 5_184_000 });
      graph.getMe.mockResolvedValue({ userId: `70${seed}`, username: 'shop', name: null });
      expect(await sweepInstagramTokens(accountA)).toEqual({ refreshed: 1, checked: 1, failures: 0 });
      expect(graph.refreshToken).toHaveBeenCalledWith('test-only-old');
      expect(graph.getMe).toHaveBeenCalledWith('test-only-refreshed');
      const row = await accountRow(id);
      expect(decrypt(row.access_token_enc)).toBe('test-only-refreshed');
      expect(new Date(row.token_expires_at).getTime()).toBeGreaterThan(Date.now() + 50 * 86_400_000);

      // Not due again: health only.
      graph.refreshToken.mockReset();
      expect(await sweepInstagramTokens(accountA)).toEqual({ refreshed: 0, checked: 1, failures: 0 });
      expect(graph.refreshToken).not.toHaveBeenCalled();

      vi.stubEnv('INSTAGRAM_ENABLED', 'false');
      graph.getMe.mockReset();
      expect(await sweepInstagramTokens(accountA)).toEqual({ refreshed: 0, checked: 0, failures: 0 });
      resetInstagramScheduleForTests();
      expect(await scheduleInstagramSweeps(Date.now(), true)).toBe(0);
      expect(graph.getMe).not.toHaveBeenCalled();
    });

    it('queues one sweep per day for workspaces with a live account only', async () => {
      resetInstagramScheduleForTests();
      await scheduleInstagramSweeps(Date.now(), true);
      await scheduleInstagramSweeps(Date.now(), true);
      const queued = (await owner.query(
        "SELECT tenant_id::text AS tenant_id, count(*)::int AS n FROM jobs WHERE type='instagram.token_sweep' AND tenant_id=ANY($1::uuid[]) GROUP BY tenant_id",
        [[accountA, accountB, accountC]])).rows as { tenant_id: string; n: number }[];
      expect(queued.map((r) => r.tenant_id).sort()).toEqual([accountA, accountB].sort());
      expect(queued.every((r) => r.n === 1)).toBe(true);
    });
  });

  describe('comment rules', () => {
    it('admins create, edit, list and delete rules through RLS', async () => {
      // The sweep test disconnected every account of workspace A; reactivate the two these tests use.
      await owner.query("UPDATE instagram_accounts SET status='active', access_token_enc=$1 WHERE id=ANY($2::uuid[])",
        [encrypt('test-only-ig-token'), [igA, igNoComments]]);
      const rule = await createCommentRule(actor('admin'), igA,
        { mediaId: '17890001', keywords: [' Price ', 'price', 'LINK'], replyText: 'Here is the link', active: true });
      expect(rule.keywords).toEqual(['price', 'link']);
      const edited = await updateCommentRule(actor('admin'), igA, rule.id, { active: false, mediaId: null });
      expect([edited.active, edited.mediaId, edited.replyText]).toEqual([false, null, 'Here is the link']);
      expect((await listCommentRules(actor('owner', ownerA), igA)).map((r) => r.id)).toEqual([rule.id]);
      expect((await owner.query("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action LIKE 'instagram.comment_rule.%'",
        [accountA])).rows[0].n).toBe(2);
      await deleteCommentRule(actor('admin'), igA, rule.id);
      expect(await listCommentRules(actor('admin'), igA)).toEqual([]);
    });

    it('refuses agents, a missing comments permission and another workspace’s ids', async () => {
      expect(await codeOf(listCommentRules(actor('agent'), igA))).toBe('forbidden');
      expect(await codeOf(createCommentRule(actor('admin'), igNoComments,
        { mediaId: null, keywords: [], replyText: 'x', active: true }))).toBe('instagram_permission_missing');
      expect(await codeOf(listCommentRules(actor('admin'), igB))).toBe('not_found');
      const [ruleB] = (await owner.query('SELECT id FROM instagram_comment_rules WHERE account_id=$1', [accountB])).rows;
      expect(await codeOf(updateCommentRule(actor('admin'), igA, ruleB.id, { active: false }))).toBe('not_found');
      expect(await codeOf(deleteCommentRule(actor('admin'), igA, ruleB.id))).toBe('not_found');
      expect((await owner.query('SELECT active FROM instagram_comment_rules WHERE id=$1', [ruleB.id])).rows[0].active).toBe(true);
      // RLS backs the service: an agent's direct write is refused by the database too.
      const asAgent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
      expect(await pgCode(withTenant(asAgent, (tx) => tx.$executeRaw`INSERT INTO instagram_comment_rules(instagram_account_id,reply_text)
        VALUES(${igA}::uuid,'x')`))).not.toBeNull();
    });

    it('the post picker reads posts with this workspace’s own token and refuses before any call otherwise', async () => {
      const post = { id: '17890001', caption: 'Sale', mediaType: 'IMAGE', previewUrl: null, permalink: null, timestamp: null };
      graph.listMedia.mockResolvedValueOnce([post]);
      expect(await listRecentPosts(actor('admin'), igA)).toEqual([post]);
      const [{ ig_user_id: igUserOfA }] = (await owner.query('SELECT ig_user_id FROM instagram_accounts WHERE id=$1', [igA])).rows;
      expect(graph.listMedia).toHaveBeenCalledExactlyOnceWith(igUserOfA, 'test-only-ig-token');
      graph.listMedia.mockClear();
      expect(await codeOf(listRecentPosts(actor('agent'), igA))).toBe('forbidden');
      expect(await codeOf(listRecentPosts(actor('admin'), igB))).toBe('not_found');
      expect(await codeOf(listRecentPosts(actor('admin'), igNoComments))).toBe('instagram_permission_missing');
      expect(graph.listMedia).not.toHaveBeenCalled();
      graph.listMedia.mockRejectedValueOnce(new MetaApiError('Meta API error: 401', { code: 190, httpStatus: 401 }));
      expect(await codeOf(listRecentPosts(actor('admin'), igA))).toBe('instagram_token_invalid');
      graph.listMedia.mockRejectedValueOnce(new MetaApiError('Meta API error: 500', { httpStatus: 500 }));
      expect(await codeOf(listRecentPosts(actor('admin'), igA))).toBe('meta_error');
      // Reading posts changes nothing: the account is still active.
      expect((await owner.query('SELECT status FROM instagram_accounts WHERE id=$1', [igA])).rows[0].status).toBe('active');
    });

    it('refuses everything while Instagram is off', async () => {
      vi.stubEnv('INSTAGRAM_ENABLED', 'false');
      expect(await codeOf(listCommentRules(actor('admin'), igA))).toBe('instagram_not_enabled');
      expect(await codeOf(listRecentPosts(actor('admin'), igA))).toBe('instagram_not_enabled');
      expect(await codeOf(checkHealth(accountA, igA))).toBe('instagram_not_enabled');
      expect(graph.getMe).not.toHaveBeenCalled();
    });
  });
});
