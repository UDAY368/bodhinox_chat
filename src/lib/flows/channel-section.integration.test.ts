// Flows per channel (Stage 1) on PostgreSQL: the channel lock and the
// turned-off-channel refusal under real row locks and RLS, the per-channel
// list filter through the browser data client and the worker client the
// engine uses, and the legacy-URL scope lookup, each confined to its tenant.
//
// Connection settings come only from the environment (TEST_DATABASE_URL,
// TEST_APP_DATABASE_URL, TEST_WORKER_DATABASE_URL), as test-db-local.cjs sets
// them; the suite is skipped without them and refuses a non-test database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { createScopedClient } from '@/lib/data/server';
import { readFlowScope } from '@/app/(dashboard)/flows/_lib/legacy-target';
import { assertFlowChannelOpen, assertScopeChangeAllowed } from './channel-section';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const ownerA = randomUUID(), ownerB = randomUUID();
const tenantA: TenantContext = { accountId: A, userId: ownerA, role: 'owner' };
const tenantB: TenantContext = { accountId: B, userId: ownerB, role: 'owner' };
const waDraft = randomUUID(), igDraft = randomUUID(), legacyAny = randomUUID(), published = randomUUID(), flowOfB = randomUUID();

let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const scopeOf = async (id: string) => (await q('SELECT channel_scope FROM flows WHERE id=$1', [id])).rows[0]?.channel_scope;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('flows per channel on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Flow channels', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[ownerA, ownerB]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Flow channels A',$2),($3,'Flow channels B',$4)", [A, ownerA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [A, ownerA, B, ownerB]);
    // waDraft leaves channel_scope to its default: every flow made before Phase 11 is WhatsApp.
    await q(`INSERT INTO flows(id,account_id,user_id,name,trigger_type) VALUES($1,$2,$3,'WA draft','keyword')`, [waDraft, A, ownerA]);
    await q(`INSERT INTO flows(id,account_id,user_id,name,trigger_type,channel_scope) VALUES
      ($1,$2,$3,'IG draft','keyword','instagram'),($4,$2,$3,'Legacy both','keyword','any'),($5,$2,$3,'Published','keyword','whatsapp'),
      ($6,$7,$8,'B flow','keyword','instagram')`, [igDraft, A, ownerA, legacyAny, published, flowOfB, B, ownerB]);
    const [version] = await withTenant(tenantA, (tx) => tx.$queryRaw<{ id: string }[]>`
      INSERT INTO flow_versions(flow_id,version,trigger_type,trigger_config,entry_node_id,fallback_policy,channel_scope,nodes,published_by)
      VALUES(${published}::uuid,1,'keyword','{"keywords":["hi"]}'::jsonb,'start','{}'::jsonb,'whatsapp','[]'::jsonb,${ownerA}::uuid)
      RETURNING id::text`);
    await q("UPDATE flows SET published_version_id=$1, status='paused' WHERE id=$2", [version.id, published]);
  });

  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, ownerB]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('defaults an existing flow to WhatsApp and refuses a scope outside the check', async () => {
    expect(await scopeOf(waDraft)).toBe('whatsapp');
    await expect(q("UPDATE flows SET channel_scope='sms' WHERE id=$1", [waDraft])).rejects.toThrow();
  });

  it('lets a never-published flow change channel and locks a published one (409 channel_locked)', async () => {
    await expect(withTenant(tenantA, (tx) => assertScopeChangeAllowed(tx, A, waDraft, 'instagram'))).resolves.toBeUndefined();
    await expect(withTenant(tenantA, (tx) => assertScopeChangeAllowed(tx, A, published, 'instagram')))
      .rejects.toMatchObject({ code: 'channel_locked', channel: 'whatsapp' });
    await expect(withTenant(tenantA, (tx) => assertScopeChangeAllowed(tx, A, published, 'whatsapp'))).resolves.toBeUndefined();
  });

  it("never reads or locks another workspace's flow", async () => {
    // Under A's tenant B's flow is invisible (RLS), even when asked for by B's account id.
    await expect(withTenant(tenantA, (tx) => assertScopeChangeAllowed(tx, B, flowOfB, 'whatsapp'))).resolves.toBeUndefined();
    await expect(withTenant(tenantA, (tx) => assertFlowChannelOpen(tx, B, flowOfB))).resolves.toBeUndefined();
    expect(await withTenant(tenantA, (tx) => readFlowScope(tx, A, flowOfB))).toBeNull();
    expect(await withTenant(tenantA, (tx) => readFlowScope(tx, B, flowOfB))).toBeNull();
    expect(await withTenant(tenantB, (tx) => readFlowScope(tx, B, flowOfB))).toBe('instagram');
    expect(await withTenant(tenantA, (tx) => readFlowScope(tx, A, 'not-a-uuid'))).toBeNull();
  });

  it('refuses publishing on a turned-off channel (409 channel_disabled) and allows it once the channel is on', async () => {
    // Instagram is off for A by default (no account connected, no row).
    await expect(withTenant(tenantA, (tx) => assertFlowChannelOpen(tx, A, igDraft))).rejects.toMatchObject({ code: 'channel_disabled', channel: 'instagram' });
    await expect(withTenant(tenantA, (tx) => assertFlowChannelOpen(tx, A, waDraft))).resolves.toBeUndefined();
    await expect(withTenant(tenantA, (tx) => assertFlowChannelOpen(tx, A, legacyAny))).resolves.toBeUndefined();
    // With WhatsApp turned off too (a row written as the database owner: the API keeps one channel on),
    // neither a WhatsApp flow nor a legacy flow on both channels can go live; B is unaffected.
    await q("INSERT INTO workspace_channels(account_id,channel,enabled) VALUES($1,'whatsapp',false)", [A]);
    try {
      await expect(withTenant(tenantA, (tx) => assertFlowChannelOpen(tx, A, waDraft))).rejects.toMatchObject({ code: 'channel_disabled', channel: 'whatsapp' });
      await expect(withTenant(tenantA, (tx) => assertFlowChannelOpen(tx, A, legacyAny))).rejects.toMatchObject({ code: 'channel_disabled' });
    } finally {
      await q("DELETE FROM workspace_channels WHERE account_id=$1", [A]);
    }
    await expect(withTenant(tenantA, (tx) => assertFlowChannelOpen(tx, A, waDraft))).resolves.toBeUndefined();
  });

  it("lists one channel's flows plus legacy ones through the browser and the worker clients, per tenant", async () => {
    const ids = (rows: unknown) => ((rows ?? []) as { id: string }[]).map((r) => r.id).sort();
    const browser = createScopedClient(tenantA);
    const whatsapp = await browser.from('flows').select('id').in('channel_scope', ['whatsapp', 'any']);
    expect(whatsapp.error).toBeNull();
    expect(ids(whatsapp.data)).toEqual([waDraft, legacyAny, published].sort());
    const instagram = await browser.from('flows').select('id').in('channel_scope', ['instagram', 'any']);
    expect(ids(instagram.data)).toEqual([igDraft, legacyAny].sort());
    // The engine's worker client applies the same filter, still confined to A.
    const worker = createScopedClient({ accountId: A, role: 'owner' }, undefined, true);
    const live = await worker.from('flows').select('id').eq('account_id', A).in('channel_scope', ['instagram', 'any']);
    expect(live.error).toBeNull();
    expect(ids(live.data)).toEqual([igDraft, legacyAny].sort());
    expect(ids(live.data)).not.toContain(flowOfB);
  });
});
