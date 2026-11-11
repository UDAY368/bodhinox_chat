// Stage 3 (3D) on a real PostgreSQL: the Instagram persistent menu.
// Instagram's Graph API is mocked: no request ever leaves the test.
//   - admins only; at most 20 items; titles distinct; links https only
//   - a flow item must be a live Instagram flow of the same workspace
//   - stored only after Meta accepts, with menu:<flow id> payloads
//   - a Meta failure stores nothing; a save that lost a race stores nothing
//   - another workspace's account is not found; B reads none of A's menu
//   - the menu is written to its own column and does not touch the ice breakers
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { MetaApiError } from '@/lib/whatsapp/meta-api';

const graph = vi.hoisted(() => ({ setPersistentMenu: vi.fn() }));
vi.mock('@/lib/instagram/graph', async (original) => ({ ...(await original<typeof import('@/lib/instagram/graph')>()), ...graph }));

import { InstagramError } from './errors';
import { getPersistentMenu, setPersistentMenuItems } from './persistent-menu';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const DM = ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments'];
const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
let igA = '', igB = '', igFlowA = '', waFlowA = '', archivedFlowA = '', igFlowB = '';

const actor = (role: 'owner' | 'admin' | 'agent', accountId = accountA) =>
  ({ accountId, userId: accountId === accountB ? ownerB : role === 'agent' ? agentA : adminA, role });
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof InstagramError ? e.code : String(e)));
const storedOf = async (id: string) => (await owner.query(
  'SELECT persistent_menu, persistent_menu_synced_at, ice_breakers FROM instagram_accounts WHERE id=$1', [id])).rows[0];
const link = (title: string, url = 'https://example.com') => ({ type: 'web_url', title, url });

async function addAccount(accountId: string, userId: string, igUserId: string): Promise<string> {
  return (await owner.query(
    `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id,token_expires_at,token_refreshed_at)
     VALUES($1,$2,'shop',$3,$4,$5,now()+interval '50 days',now()) RETURNING id`,
    [accountId, igUserId, encrypt('test-only-ig-token'), DM, userId])).rows[0].id;
}
async function addFlow(accountId: string, userId: string, scope: string, status = 'draft'): Promise<string> {
  return (await owner.query(`INSERT INTO flows(account_id,user_id,name,trigger_type,channel_scope,status)
    VALUES($1,$2,'Flow','manual',$3,$4) RETURNING id`, [accountId, userId, scope, status])).rows[0].id;
}

function enable() {
  vi.stubEnv('INSTAGRAM_ENABLED', 'true');
  vi.stubEnv('INSTAGRAM_APP_ID', '1234567890');
  vi.stubEnv('INSTAGRAM_APP_SECRET', 'test-only-ig-secret');
  vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'test-only-verify');
  vi.stubEnv('APP_URL', 'https://app.example.test');
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram persistent menu (3D) on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    const users = [ownerA, adminA, agentA, ownerB];
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'IG menu', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'IG menu A',$2),($3,'IG menu B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner')`,
      [accountA, ownerA, adminA, agentA, accountB, ownerB]);
    igA = await addAccount(accountA, ownerA, `93${seed}`);
    igB = await addAccount(accountB, ownerB, `94${seed}`);
    igFlowA = await addFlow(accountA, ownerA, 'instagram');
    waFlowA = await addFlow(accountA, ownerA, 'whatsapp');
    archivedFlowA = await addFlow(accountA, ownerA, 'instagram', 'archived');
    igFlowB = await addFlow(accountB, ownerB, 'instagram');
  });
  beforeEach(() => {
    vi.unstubAllEnvs();
    enable();
    graph.setPersistentMenu.mockReset();
    graph.setPersistentMenu.mockResolvedValue(undefined);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (owner) {
      const accounts = [accountA, accountB];
      await owner.query('DELETE FROM flows WHERE account_id=ANY($1::uuid[])', [accounts]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [accounts]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, adminA, agentA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('starts unmanaged: nothing set by Bodhinox yet', async () => {
    expect(await getPersistentMenu(actor('agent'), igA))
      .toEqual({ instagramAccountId: igA, managed: false, syncedAt: null, items: [] });
  });

  it('an admin sets it on Meta first, then it is stored, and any member reads it', async () => {
    const view = await setPersistentMenuItems(actor('admin'), igA, [
      { type: 'postback', title: 'Book a call', flowId: igFlowA }, link('Our site'),
    ]);
    expect(graph.setPersistentMenu).toHaveBeenCalledTimes(1);
    const [igUserId, token, items] = graph.setPersistentMenu.mock.calls[0];
    expect([igUserId, token]).toEqual([`93${seed}`, 'test-only-ig-token']);
    expect(items).toEqual([
      { type: 'postback', title: 'Book a call', payload: `menu:${igFlowA}` },
      { type: 'web_url', title: 'Our site', url: 'https://example.com' },
    ]);
    const row = await storedOf(igA);
    expect(row.persistent_menu).toEqual([
      { type: 'postback', title: 'Book a call', flow_id: igFlowA }, { type: 'web_url', title: 'Our site', url: 'https://example.com' },
    ]);
    expect(row.persistent_menu_synced_at).not.toBeNull();
    expect(row.ice_breakers).toBeNull();
    expect(view.managed).toBe(true);
    expect(view.items.map((i) => [i.title, i.flowUsable])).toEqual([['Book a call', true], ['Our site', true]]);
    expect((await getPersistentMenu(actor('agent'), igA)).items).toHaveLength(2);
    expect((await owner.query("SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='instagram.persistent_menu.update'", [accountA]))
      .rows.map((r) => r.metadata)).toEqual([{ items: 2 }]);
  });

  it('refuses a non-admin, a bad list and any flow that is not a live Instagram flow of this workspace, before Meta', async () => {
    expect(await codeOf(setPersistentMenuItems(actor('agent'), igA, [link('A')]))).toBe('forbidden');
    const tooMany = Array.from({ length: 21 }, (_, i) => link(`T${i}`));
    expect(await codeOf(setPersistentMenuItems(actor('admin'), igA, tooMany))).toBe('invalid_request');
    expect(await codeOf(setPersistentMenuItems(actor('admin'), igA, [link('A'), link('a')]))).toBe('invalid_request');
    expect(await codeOf(setPersistentMenuItems(actor('admin'), igA, [link('A', 'http://example.com')]))).toBe('invalid_request');
    for (const flowId of [waFlowA, archivedFlowA, igFlowB, randomUUID()]) {
      expect(await codeOf(setPersistentMenuItems(actor('admin'), igA, [{ type: 'postback', title: 'Go', flowId }]))).toBe('invalid_request');
    }
    expect(graph.setPersistentMenu).not.toHaveBeenCalled();
  });

  it('stores nothing when Meta refuses or throttles', async () => {
    const before = await storedOf(igA);
    graph.setPersistentMenu.mockRejectedValueOnce(new MetaApiError('Meta API error: 500', { httpStatus: 500 }));
    expect(await codeOf(setPersistentMenuItems(actor('admin'), igA, [link('New')]))).toBe('meta_error');
    graph.setPersistentMenu.mockRejectedValueOnce(new MetaApiError('Meta API error: 401', { httpStatus: 401, code: 190 }));
    expect(await codeOf(setPersistentMenuItems(actor('admin'), igA, [link('New')]))).toBe('instagram_token_invalid');
    expect(await storedOf(igA)).toEqual(before);
  });

  it('a save that another save overtook stores nothing and asks to retry', async () => {
    const before = await storedOf(igA);
    graph.setPersistentMenu.mockImplementationOnce(async () => {
      // Another admin's save lands while this one is talking to Meta.
      await owner.query("UPDATE instagram_accounts SET persistent_menu_synced_at=now()+interval '1 second' WHERE id=$1", [igA]);
    });
    expect(await codeOf(setPersistentMenuItems(actor('admin'), igA, [link('Raced')]))).toBe('rate_limited');
    expect((await storedOf(igA)).persistent_menu).toEqual(before.persistent_menu);
  });

  it('an empty list removes the menu on Meta and stores an empty list', async () => {
    await setPersistentMenuItems(actor('admin'), igA, []);
    expect(graph.setPersistentMenu.mock.calls[0][2]).toEqual([]);
    expect((await storedOf(igA)).persistent_menu).toEqual([]);
  });

  it('keeps other workspaces out: their account is not found and B reads none of A’s menu', async () => {
    expect(await codeOf(getPersistentMenu(actor('admin'), igB))).toBe('not_found');
    expect(await codeOf(setPersistentMenuItems(actor('admin'), igB, [link('A')]))).toBe('not_found');
    expect(await codeOf(getPersistentMenu(actor('owner', accountB), igA))).toBe('not_found');
    const seen = await withTenant({ accountId: accountB, userId: ownerB, role: 'owner' },
      (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM instagram_accounts WHERE persistent_menu IS NOT NULL`);
    expect(seen[0].n).toBe(0);
    expect(graph.setPersistentMenu).not.toHaveBeenCalled();
  });

  it('shows a menu item whose flow was archived as not usable', async () => {
    await setPersistentMenuItems(actor('admin'), igA, [{ type: 'postback', title: 'Book', flowId: igFlowA }]);
    await owner.query("UPDATE flows SET status='archived' WHERE id=$1", [igFlowA]);
    try {
      const view = await getPersistentMenu(actor('agent'), igA);
      expect(view.items).toEqual([expect.objectContaining({ flowId: igFlowA, flowUsable: false })]);
    } finally {
      await owner.query("UPDATE flows SET status='draft' WHERE id=$1", [igFlowA]);
    }
  });

  it('the app role cannot write the menu column directly', async () => {
    await expect(getPrisma().$executeRaw`UPDATE instagram_accounts SET persistent_menu='[]'::jsonb WHERE id=${igA}::uuid`).rejects.toThrow();
  });
});
