// Stage 1 channel separation on PostgreSQL: workspace_channels row security
// and grants for the app and worker roles, the effective state computed from
// real rows (numbers, Instagram accounts), the channel rules under RLS, the
// audit row, and automations.channel (default and CHECK).
//
// Connection settings come only from the environment (TEST_DATABASE_URL,
// TEST_APP_DATABASE_URL, TEST_WORKER_DATABASE_URL), as test-db-local.cjs sets
// them; the suite is skipped without them and refuses a non-test database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { ensureChannelEnabled, getWorkspaceChannels, setWorkspaceChannels } from './workspace';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID(), accountC = randomUUID();
const admin = randomUUID(), agent = randomUUID(), viewer = randomUUID(), ownerB = randomUUID(), ownerC = randomUUID();
const adminA: TenantContext = { accountId: accountA, userId: admin, role: 'admin' };
const agentA: TenantContext = { accountId: accountA, userId: agent, role: 'agent' };
const viewerA: TenantContext = { accountId: accountA, userId: viewer, role: 'viewer' };
const ownerOfB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const ownerOfC: TenantContext = { accountId: accountC, userId: ownerC, role: 'owner' };
const workerA: TenantContext = { accountId: accountA, role: 'owner' };
const workerB: TenantContext = { accountId: accountB, role: 'owner' };

let owner: pg.Client;
const previousFlag = process.env.INSTAGRAM_ENABLED;
const rowsOf = (account: string) => owner.query<{ channel: string; enabled: boolean; updated_by_user_id: string | null }>(
  'SELECT channel, enabled, updated_by_user_id FROM workspace_channels WHERE account_id=$1 ORDER BY channel', [account]).then((r) => r.rows);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('workspace channels on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    const users = [admin, agent, viewer, ownerB, ownerC];
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Channels test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Channels A',$2),($3,'Channels B',$4),($5,'Channels C',$6)",
      [accountA, admin, accountB, ownerB, accountC, ownerC]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner'),($7,$8,'owner')`,
      [accountA, admin, agent, viewer, accountB, ownerB, accountC, ownerC]);
    // A has a live WhatsApp number; B has an active Instagram account and no number; C has nothing.
    await owner.query(`INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token,status)
      VALUES($1,$2,$3,'enc-test-token','connected')`, [accountA, admin, `9${Date.now()}`.slice(0, 15)]);
    await owner.query(`INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,connected_by_user_id)
      VALUES($1,$2,'channels_b','enc-test-token',$3)`, [accountB, `${Date.now()}`.slice(0, 15), ownerB]);
  });

  afterEach(() => {
    if (previousFlag === undefined) delete process.env.INSTAGRAM_ENABLED;
    else process.env.INSTAGRAM_ENABLED = previousFlag;
  });

  afterAll(async () => {
    await owner?.end();
    await disconnectDatabases();
  });

  it('gives a workspace without rows today\'s behaviour, from its own connections only', async () => {
    process.env.INSTAGRAM_ENABLED = 'true';
    const a = await withTenant(viewerA, (tx) => getWorkspaceChannels(tx, accountA));
    expect(a.enabled).toEqual(['whatsapp']);
    expect(a.chosen).toBe(false);
    expect(a.channels.whatsapp).toMatchObject({ connection: 'live', state: 'live', explicit: false });
    expect(a.channels.instagram).toMatchObject({ connection: 'none', state: 'off', enabled: false });
    // B's Instagram account turns Instagram on by default for B, and never shows in A.
    const b = await withTenant(ownerOfB, (tx) => getWorkspaceChannels(tx, accountB));
    expect(b.enabled).toEqual(['whatsapp', 'instagram']);
    expect(b.channels.instagram).toMatchObject({ connection: 'live', state: 'live' });
    expect(b.channels.whatsapp).toMatchObject({ connection: 'none', state: 'setup' });
    // Asking for another workspace's id under A's scope sees none of B's rows.
    const cross = await withTenant(viewerA, (tx) => getWorkspaceChannels(tx, accountB));
    expect(cross.channels.instagram.connection).toBe('none');
    expect(cross.channels.whatsapp.connection).toBe('none');
  });

  it('lets only admins write, as themselves, and keeps rows per tenant', async () => {
    await expect(withTenant(agentA, (tx) => tx.$executeRaw`INSERT INTO workspace_channels(account_id,channel,enabled)
      VALUES(${accountA}::uuid,'instagram',true)`)).rejects.toThrow();
    await expect(withTenant(viewerA, (tx) => tx.$executeRaw`INSERT INTO workspace_channels(account_id,channel,enabled)
      VALUES(${accountA}::uuid,'instagram',true)`)).rejects.toThrow();
    // An admin cannot write into another workspace or record someone else as the editor.
    await expect(withTenant(adminA, (tx) => tx.$executeRaw`INSERT INTO workspace_channels(account_id,channel,enabled)
      VALUES(${accountB}::uuid,'instagram',false)`)).rejects.toThrow();
    await expect(withTenant(adminA, (tx) => tx.$executeRaw`INSERT INTO workspace_channels(account_id,channel,enabled,updated_by_user_id)
      VALUES(${accountA}::uuid,'instagram',false,${agent}::uuid)`)).rejects.toThrow();
    // No delete grant: switching off is a row update, never a delete.
    await expect(withTenant(adminA, (tx) => tx.$executeRaw`DELETE FROM workspace_channels WHERE account_id=${accountA}::uuid`)).rejects.toThrow();
    // The CHECK refuses an unknown channel.
    await expect(owner.query("INSERT INTO workspace_channels(account_id,channel,enabled) VALUES($1,'sms',true)", [accountA])).rejects.toThrow(/check/i);
    expect(await rowsOf(accountA)).toEqual([]);
  });

  it('applies the channel rules and audits an admin change', async () => {
    process.env.INSTAGRAM_ENABLED = 'true';
    // A's number is connected: WhatsApp cannot be turned off.
    await expect(withTenant(adminA, (tx) => setWorkspaceChannels(tx, { accountId: accountA, userId: admin }, { whatsapp: false, instagram: true })))
      .rejects.toMatchObject({ code: 'channel_connected', status: 409 });
    expect(await rowsOf(accountA)).toEqual([]);
    const state = await withTenant(adminA, (tx) => setWorkspaceChannels(tx, { accountId: accountA, userId: admin }, { whatsapp: true, instagram: true }));
    expect(state).toMatchObject({ enabled: ['whatsapp', 'instagram'], chosen: true });
    expect(state.channels.instagram).toMatchObject({ explicit: true, state: 'setup' });
    expect(await rowsOf(accountA)).toEqual([
      { channel: 'instagram', enabled: true, updated_by_user_id: admin },
      { channel: 'whatsapp', enabled: true, updated_by_user_id: admin },
    ]);
    const audit = await owner.query("SELECT user_id, metadata FROM audit_logs WHERE account_id=$1 AND action='channels.updated'", [accountA]);
    expect(audit.rows).toEqual([{ user_id: admin, metadata: { whatsapp: true, instagram: true } }]);
    // Instagram is not connected in A, so it can be turned off again.
    const off = await withTenant(adminA, (tx) => setWorkspaceChannels(tx, { accountId: accountA, userId: admin }, { instagram: false }));
    expect(off.enabled).toEqual(['whatsapp']);
    // Other members read the same state; other tenants see no rows.
    expect((await withTenant(viewerA, (tx) => getWorkspaceChannels(tx, accountA))).channels.instagram).toMatchObject({ explicit: true, enabled: false });
    expect(await withTenant(ownerOfB, (tx) => tx.$queryRaw<unknown[]>`SELECT 1 FROM workspace_channels WHERE account_id=${accountA}::uuid`)).toEqual([]);
    expect(await withTenant(workerB, (tx) => tx.$queryRaw<unknown[]>`SELECT 1 FROM workspace_channels WHERE account_id=${accountA}::uuid`, getWorkerPrisma())).toEqual([]);
    // Connected implies enabled on read too: a stale 'off' row never hides A's live number.
    await owner.query("UPDATE workspace_channels SET enabled=false WHERE account_id=$1 AND channel='whatsapp'", [accountA]);
    expect((await withTenant(viewerA, (tx) => getWorkspaceChannels(tx, accountA))).channels.whatsapp)
      .toMatchObject({ explicit: true, enabled: true, state: 'live' });
    await owner.query("UPDATE workspace_channels SET enabled=true WHERE account_id=$1 AND channel='whatsapp'", [accountA]);
  });

  it('keeps one channel on and gates Instagram on the platform flag', async () => {
    process.env.INSTAGRAM_ENABLED = 'false';
    await expect(withTenant(ownerOfC, (tx) => setWorkspaceChannels(tx, { accountId: accountC, userId: ownerC }, { instagram: true })))
      .rejects.toMatchObject({ code: 'platform_off', status: 503 });
    await expect(withTenant(ownerOfC, (tx) => setWorkspaceChannels(tx, { accountId: accountC, userId: ownerC }, { whatsapp: false })))
      .rejects.toMatchObject({ code: 'last_channel', status: 409 });
    process.env.INSTAGRAM_ENABLED = 'true';
    const igOnly = await withTenant(ownerOfC, (tx) => setWorkspaceChannels(tx, { accountId: accountC, userId: ownerC }, { whatsapp: false, instagram: true }));
    expect(igOnly.enabled).toEqual(['instagram']);
    expect(igOnly.channels.whatsapp.state).toBe('off');
    // With the platform off again, the Instagram-only workspace has no usable channel until WhatsApp is back on.
    process.env.INSTAGRAM_ENABLED = 'false';
    expect((await withTenant(ownerOfC, (tx) => getWorkspaceChannels(tx, accountC))).channels.instagram.state).toBe('unavailable');
    expect(await rowsOf(accountC)).toEqual([
      { channel: 'instagram', enabled: true, updated_by_user_id: ownerC },
      { channel: 'whatsapp', enabled: false, updated_by_user_id: ownerC },
    ]);
  });

  it('lets a connect path running as the worker turn a channel on, in its own workspace only', async () => {
    process.env.INSTAGRAM_ENABLED = 'true';
    await withTenant(workerA, (tx) => ensureChannelEnabled(tx, accountA, 'instagram'), getWorkerPrisma());
    expect((await rowsOf(accountA)).find((r) => r.channel === 'instagram')).toEqual({ channel: 'instagram', enabled: true, updated_by_user_id: null });
    await expect(withTenant(workerA, (tx) => tx.$executeRaw`INSERT INTO workspace_channels(account_id,channel,enabled)
      VALUES(${accountB}::uuid,'whatsapp',true)`, getWorkerPrisma())).rejects.toThrow();
    // Idempotent: an already-enabled row is left as it is.
    await withTenant(workerA, (tx) => ensureChannelEnabled(tx, accountA, 'instagram'), getWorkerPrisma());
    expect((await rowsOf(accountA)).filter((r) => r.channel === 'instagram')).toHaveLength(1);
  });

  it('puts every existing and new automation on WhatsApp unless told otherwise, and refuses other values', async () => {
    const legacy = await owner.query("INSERT INTO automations(account_id,user_id,name,trigger_type) VALUES($1,$2,'Legacy','keyword_match') RETURNING channel", [accountA, admin]);
    expect(legacy.rows[0].channel).toBe('whatsapp');
    const ig = await withTenant(adminA, (tx) => tx.$queryRaw<{ channel: string }[]>`INSERT INTO automations(account_id,user_id,name,trigger_type,channel)
      VALUES(${accountA}::uuid,${admin}::uuid,'IG','keyword_match','instagram') RETURNING channel`);
    expect(ig[0].channel).toBe('instagram');
    await expect(owner.query("INSERT INTO automations(account_id,user_id,name,trigger_type,channel) VALUES($1,$2,'Any','keyword_match','any')", [accountA, admin]))
      .rejects.toThrow(/automations_channel_check/);
    const validated = await owner.query("SELECT convalidated FROM pg_constraint WHERE conname='automations_channel_check'");
    expect(validated.rows[0].convalidated).toBe(true);
    const index = await owner.query("SELECT indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='idx_automations_account_channel_active_trigger'");
    expect(index.rows[0].indisvalid).toBe(true);
    // Another workspace never reads A's automations by channel.
    expect(await withTenant(ownerOfB, (tx) => tx.$queryRaw<unknown[]>`SELECT 1 FROM automations WHERE account_id=${accountA}::uuid AND channel='instagram'`)).toEqual([]);
  });

  it('forces row security on workspace_channels', async () => {
    const rls = await owner.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='workspace_channels'");
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
