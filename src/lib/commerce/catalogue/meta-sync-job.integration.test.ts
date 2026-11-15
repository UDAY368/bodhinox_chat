import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@/lib/auth/account';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import type { MetaCatalogItemUpdate } from '@/lib/whatsapp/meta-api';
import { pushCatalogChanges, type CatalogUpdater } from '../catalog-push';
import { getMetaSyncView, META_SYNC_JOB, reconcileMetaItem, requestMetaSync, runMetaCatalogueSync, saveMetaSyncSettings } from './meta-sync-job';

// Store plan Phase 4 (package 4) on PostgreSQL, with Meta's Graph API mocked at fetch: full Meta catalogue sync.
// Tenancy (another workspace's items and catalogue are never touched), roles (an agent cannot switch it on or
// reconcile), durability (the intent and the pending marks are committed before the call; an uncertain CREATE is
// never sent again until an admin reconciles it; an UPDATE may retry; throttling backs off) and job dedupe.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
process.env.APP_URL = 'https://app.example.test';

const seed = String(Date.now()).slice(-9);
const accountA = randomUUID(), accountB = randomUUID(), accountC = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID(), ownerC = randomUUID();
const users = [ownerA, adminA, agentA, ownerB, ownerC];
const asAdmin = { accountId: accountA, userId: adminA, role: 'admin' } as TenantContext & { userId: string };
const asAgent = { accountId: accountA, userId: agentA, role: 'agent' } as TenantContext & { userId: string };
const asOwnerB = { accountId: accountB, userId: ownerB, role: 'owner' } as TenantContext & { userId: string };
const asOwnerC = { accountId: accountC, userId: ownerC, role: 'owner' } as TenantContext & { userId: string };
const catalogA = `71${seed}`, catalogB = `72${seed}`;
const TOKEN_A = `token-a-${seed}`, TOKEN_B = `token-b-${seed}`;
const handleA = `fs-${seed}`;
const shoe = randomUUID(), bare = randomUUID(), draft = randomUUID(), productB = randomUUID();
const v = { a1: randomUUID(), a2: randomUUID(), noimg: randomUUID(), draft: randomUUID(), a3: randomUUID(), a4: randomUUID(), a5: randomUUID(), a6: randomUUID(), b1: randomUUID() };
let db: pg.Client;
let catalogRowA = '';

interface GraphCall { edge: string; catalog: string; method: string; auth: string | null; url: URL; body: { item_type?: string; allow_upsert?: boolean; requests?: { method: string; data: Record<string, string> }[] } | null }
const graph = {
  calls: [] as GraphCall[],
  /** Answers the next items_batch call instead of the default (accept with a new handle that finishes clean). */
  nextBatch: null as null | (() => Response),
  status: new Map<string, Record<string, unknown>>(),
  inMeta: new Map<string, string>(),
  findFails: false,
  seq: 0,
  /** What was already committed when each items_batch call reached Meta. */
  committed: [] as { dispatching: number; pending: number }[],
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const [, , catalog, edge] = url.pathname.split('/');
  const call: GraphCall = { edge, catalog, method: init?.method ?? 'GET', url,
    auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null, body: init?.body ? JSON.parse(String(init.body)) : null };
  graph.calls.push(call);
  if (edge === 'items_batch') {
    const dispatching = await db.query("SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1 AND status='dispatching' AND idempotency_key LIKE $2",
      [accountA, `${accountA}:meta-catalogue:${catalog}:%`]);
    const pending = await db.query("SELECT count(*)::int AS n FROM shop_meta_sync_items WHERE account_id=$1 AND status='pending' AND batch_handle IS NULL AND retailer_id=ANY($2::text[])",
      [accountA, (call.body?.requests ?? []).map((r) => r.data.id)]);
    graph.committed.push({ dispatching: dispatching.rows[0].n, pending: pending.rows[0].n });
    if (graph.nextBatch) { const answer = graph.nextBatch; graph.nextBatch = null; return answer(); }
    const handle = `handle-${++graph.seq}`;
    graph.status.set(handle, { handle, status: 'finished', errors_total_count: 0, errors: [], ids_of_invalid_requests: [] });
    return reply({ handles: [handle] });
  }
  if (edge === 'check_batch_request_status') {
    const entry = graph.status.get(url.searchParams.get('handle') ?? '');
    return reply({ data: entry ? [entry] : [] });
  }
  if (edge === 'products') {
    if (graph.findFails) return reply({ error: { message: 'unavailable', code: 2 } }, 500);
    const wanted = JSON.parse(url.searchParams.get('filter') ?? '{}').retailer_id?.eq as string;
    const id = graph.inMeta.get(wanted);
    return reply({ data: id ? [{ id, retailer_id: wanted }] : [] });
  }
  return reply({ error: { message: 'unknown edge', code: 100 } }, 404);
});

const batches = () => graph.calls.filter((c) => c.edge === 'items_batch');
const skus = (call: GraphCall) => (call.body?.requests ?? []).map((r) => r.data.id).sort();
const methods = (call: GraphCall) => [...new Set((call.body?.requests ?? []).map((r) => r.method))];
const item = async (sku: string, account = accountA) => (await db.query(
  'SELECT status, method, in_meta, pushed_hash, intent_key, batch_handle, meta_product_id, error_code, error_detail, attempts FROM shop_meta_sync_items WHERE account_id=$1 AND retailer_id=$2',
  [account, sku])).rows[0];
const count = async (sql: string, values: unknown[]) => Number((await db.query(sql, values)).rows[0].n);
const syncJobs = async (account: string) => (await db.query(
  'SELECT dedupe_key, run_at, payload FROM jobs WHERE type=$1 AND tenant_id=$2 ORDER BY run_at', [META_SYNC_JOB, account])).rows;
const run = (account = accountA, options: { force?: boolean } = {}) => runMetaCatalogueSync(account, options);
/** Two runs: the first sends, the second reads the batch handle. */
const runAndSettle = async () => { await run(); return run(); };
const addVariant = (id: string, sku: string, price = 50000) =>
  db.query('INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory) VALUES($1,$2,$3,$4,$5,false)', [id, accountA, shoe, sku, price]);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('store plan phase 4: full Meta catalogue sync on PostgreSQL', { timeout: 300_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    vi.stubGlobal('fetch', fetchMock);
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P4 sync', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P4 SYNC A',$2),($3,'P4 SYNC B',$4),($5,'P4 SYNC C',$6)",
      [accountA, ownerA, accountB, ownerB, accountC, ownerC]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner'),($7,$8,'owner')`,
      [accountA, ownerA, adminA, agentA, accountB, ownerB, accountC, ownerC]);
    for (const [account, user, catalog, token, n] of [[accountA, ownerA, catalogA, TOKEN_A, '1'], [accountB, ownerB, catalogB, TOKEN_B, '2']]) {
      const number = (await db.query(
        "INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status,is_default) VALUES($1,$2,$3,$4,$5,'connected',true) RETURNING id",
        [account, user, `8${n}${seed}`, `9${n}${seed}`, encrypt(token)])).rows[0].id;
      const row = (await db.query('INSERT INTO whatsapp_catalogs(account_id,whatsapp_config_id,catalog_id) VALUES($1,$2,$3) RETURNING id', [account, number, catalog])).rows[0].id;
      if (account === accountA) catalogRowA = row;
    }
    for (const account of [accountA, accountB, accountC])
      await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,reservation_minutes)
        VALUES($1,'INR',true,0,true,30)`, [account]);
    await db.query('INSERT INTO shop_storefronts(account_id,handle,published) VALUES($1,$2,true),($3,$4,true)', [accountA, handleA, accountB, `fsb-${seed}`]);
    // A: a published product with a picture and two variants, a published one without a picture, and a draft.
    await db.query(`INSERT INTO shop_products(id,account_id,name,description,brand,status,content_reviewed_at) VALUES
      ($1,$4,'Trail shoe','Grippy sole.','Bodhi','published',now()),($2,$4,'Bare item',NULL,NULL,'published',now()),($3,$4,'Draft item',NULL,NULL,'draft',NULL)`,
      [shoe, bare, draft, accountA]);
    await db.query("INSERT INTO shop_product_images(account_id,product_id,url,position) VALUES($1,$2,'https://cdn.example.test/shoe.jpg',0),($1,$3,'https://cdn.example.test/draft.jpg',0)",
      [accountA, shoe, draft]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,option_values,track_inventory) VALUES
      ($1,$5,$6,'FS-A1',129900,'{}',false),($2,$5,$6,'FS-A2',99900,'{"Size":"M"}',false),($3,$5,$7,'FS-NOIMG',5000,'{}',false),($4,$5,$8,'FS-DRAFT',100,'{}',false)`,
      [v.a1, v.a2, v.noimg, v.draft, accountA, shoe, bare, draft]);
    // B: its own catalogue and a published product that uses one of A's SKUs.
    await db.query("INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'B shoe','published',now())", [productB, accountB]);
    await db.query("INSERT INTO shop_product_images(account_id,product_id,url,position) VALUES($1,$2,'https://cdn.example.test/b.jpg',0)", [accountB, productB]);
    await db.query("INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory) VALUES($1,$2,$3,'FS-A1',777,false)", [v.b1, accountB, productB]);
  });
  beforeEach(() => {
    graph.calls.length = 0;
    graph.committed.length = 0;
    graph.nextBatch = null;
    graph.findFails = false;
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB, accountC]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB, accountC]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('is off by default; only an admin with a linked catalogue can switch it on, and switching it on queues a run', async () => {
    const before = await withTenant(asAgent, (tx) => getMetaSyncView(tx, accountA));
    expect(before).toMatchObject({ connected: true, enabled: false, scope: 'all' });
    expect(await run()).toMatchObject({ status: 'off' });
    // Nothing queues while it is off, whatever changes.
    await db.query('UPDATE shop_variants SET price_minor=129901 WHERE id=$1', [v.a1]);
    await db.query('UPDATE shop_variants SET price_minor=129900 WHERE id=$1', [v.a1]);
    expect(await syncJobs(accountA)).toEqual([]);

    // An agent: refused by the role check, and by RLS underneath it.
    await expect(saveMetaSyncSettings(asAgent, { enabled: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(withTenant(asAgent, (tx) => tx.$executeRaw`INSERT INTO shop_meta_sync_settings(account_id,enabled) VALUES(${accountA}::uuid,true)`)).rejects.toThrow();
    await expect(requestMetaSync(asAgent)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await count('SELECT count(*) AS n FROM shop_meta_sync_settings WHERE account_id=$1', [accountA])).toBe(0);

    // No linked catalogue: a clear refusal, and the view says not connected.
    await expect(saveMetaSyncSettings(asOwnerC, { enabled: true })).rejects.toMatchObject({ code: 'meta_not_connected' });
    await expect(requestMetaSync(asOwnerC)).rejects.toMatchObject({ code: 'meta_not_connected' });
    expect((await withTenant(asOwnerC, (tx) => getMetaSyncView(tx, accountC))).connected).toBe(false);
    // Connected but not switched on: "Sync now" is refused.
    await expect(requestMetaSync(asAdmin)).rejects.toMatchObject({ code: 'meta_sync_off' });

    const view = await saveMetaSyncSettings(asAdmin, { enabled: true });
    expect(view).toMatchObject({ connected: true, enabled: true, scope: 'all' });
    const queued = await syncJobs(accountA);
    expect(queued).toHaveLength(1);
    expect(queued[0].dedupe_key).toMatch(new RegExp(`^meta-catalogue-sync:${accountA}:\\d+$`));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('queues one run per workspace per minute from the triggers, through the app role, and none for a workspace that did not opt in', async () => {
    await db.query('DELETE FROM jobs WHERE type=$1', [META_SYNC_JOB]);
    await db.query('BEGIN');
    await db.query("UPDATE shop_products SET description='Grippy sole, light.' WHERE id=$1", [shoe]);
    await db.query('UPDATE shop_variants SET price_minor=129901 WHERE id=$1', [v.a1]);
    await db.query('UPDATE shop_variants SET price_minor=129900 WHERE id=$1', [v.a1]);
    await db.query('COMMIT');
    expect(await syncJobs(accountA)).toHaveLength(1);
    await db.query('DELETE FROM jobs WHERE type=$1', [META_SYNC_JOB]);
    await withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE shop_variants SET option_values='{"Size":"L"}'::jsonb WHERE account_id=${accountA}::uuid AND id=${v.a2}::uuid`);
    const queued = await syncJobs(accountA);
    expect(queued).toHaveLength(1);
    expect(new Date(queued[0].run_at).getUTCSeconds()).toBe(0);
    // A change that Meta does not show queues nothing; neither does anything in workspace B (not opted in).
    await db.query('DELETE FROM jobs WHERE type=$1', [META_SYNC_JOB]);
    await db.query('UPDATE shop_variants SET weight_grams=300 WHERE id=$1', [v.a1]);
    await db.query('UPDATE shop_variants SET price_minor=778 WHERE id=$1', [v.b1]);
    expect(await syncJobs(accountA)).toEqual([]);
    expect(await syncJobs(accountB)).toEqual([]);
  });

  it('creates the published products in the workspace own catalogue, recording the intent and the pending marks before the call', async () => {
    const result = await run();
    expect(result).toMatchObject({ status: 'ran', batches: 1, sent: 2, requeued: true });
    const sent = batches();
    expect(sent).toHaveLength(1);
    expect(sent[0].catalog).toBe(catalogA);
    expect(sent[0].auth).toBe(`Bearer ${TOKEN_A}`);
    expect(sent[0].url.toString()).not.toContain(TOKEN_A);
    expect(sent[0].body).toMatchObject({ item_type: 'PRODUCT_ITEM', allow_upsert: false });
    expect(methods(sent[0])).toEqual(['CREATE']);
    expect(skus(sent[0])).toEqual(['FS-A1', 'FS-A2']);
    expect(sent[0].body!.requests!.find((r) => r.data.id === 'FS-A1')!.data).toEqual({
      id: 'FS-A1', title: 'Trail shoe', description: 'Grippy sole, light.', availability: 'in stock', condition: 'new', price: '1299.00 INR',
      link: `https://app.example.test/s/${handleA}/p/${shoe}`, image_link: 'https://cdn.example.test/shoe.jpg', brand: 'Bodhi', item_group_id: shoe,
    });
    expect(sent[0].body!.requests!.find((r) => r.data.id === 'FS-A2')!.data).toMatchObject({ title: 'Trail shoe - L', size: 'L', price: '999.00 INR' });
    // Durability: when the call reached Meta, the intent and both pending marks were already committed.
    expect(graph.committed).toEqual([{ dispatching: 1, pending: 2 }]);
    const a1 = await item('FS-A1');
    expect(a1).toMatchObject({ status: 'pending', method: 'CREATE', in_meta: false, batch_handle: 'handle-1', attempts: 1 });
    const intent = (await db.query('SELECT status, result FROM outbound_intents WHERE idempotency_key=$1', [a1.intent_key])).rows[0];
    expect(intent).toMatchObject({ status: 'accepted', result: { handles: ['handle-1'] } });
    expect(a1.intent_key).toMatch(new RegExp(`^${accountA}:meta-catalogue:${catalogA}:create:[0-9a-f]{64}$`));
    // A product without a picture is refused here, without a call; a draft is not considered at all.
    expect(await item('FS-NOIMG')).toMatchObject({ status: 'failed', error_code: 'missing_image', batch_handle: null });
    expect(await item('FS-DRAFT')).toBeUndefined();
    // Nothing of the product is stored in the status rows.
    expect(JSON.stringify((await db.query('SELECT * FROM shop_meta_sync_items WHERE account_id=$1', [accountA])).rows)).not.toMatch(/Trail shoe|Grippy|1299/);
    // Tenancy: B's catalogue was never called and B has no rows, although it sells the same SKU.
    expect(graph.calls.some((c) => c.catalog === catalogB || c.auth === `Bearer ${TOKEN_B}`)).toBe(false);
    expect(await count('SELECT count(*) AS n FROM shop_meta_sync_items WHERE account_id=$1', [accountB])).toBe(0);
  });

  it('settles items from the batch status, sends nothing again when replayed, and only resends a failed item on Sync now', async () => {
    graph.status.set('handle-1', { handle: 'handle-1', status: 'finished', errors_total_count: 1, errors: [{ line: 1, id: 'FS-A2', message: 'refused: Trail shoe - L' }], ids_of_invalid_requests: ['FS-A2'] });
    expect(await run()).toMatchObject({ synced: 1, failed: 1, batches: 0 });
    expect(await item('FS-A1')).toMatchObject({ status: 'synced', in_meta: true, batch_handle: null, error_code: null });
    expect(await item('FS-A2')).toMatchObject({ status: 'failed', in_meta: false, error_code: 'meta_item_invalid' });
    expect(batches()).toHaveLength(0);
    // Replaying the job any number of times sends nothing: nothing changed.
    graph.calls.length = 0;
    await run();
    await run();
    expect(graph.calls).toHaveLength(0);
    // "Sync now" (force) sends the failed item again, as a CREATE (Meta never took it), under a new intent key.
    const firstKey = (await item('FS-A2')).intent_key;
    await run(accountA, { force: true });
    expect(batches().map((c) => [methods(c), skus(c)])).toEqual([[['CREATE'], ['FS-A2']]]);
    expect((await item('FS-A2')).intent_key).not.toBe(firstKey);
    await run();
    expect(await item('FS-A2')).toMatchObject({ status: 'synced', in_meta: true, attempts: 2 });
    const view = await withTenant(asAgent, (tx) => getMetaSyncView(tx, accountA));
    expect(view.counts).toMatchObject({ synced: 2, failed: 1, uncertain: 0, pending: 0 });
    expect(view.problems.map((p) => [p.sku, p.status, p.error_code])).toEqual([['FS-NOIMG', 'failed', 'missing_image']]);
    expect(view.products.find((p) => p.product_id === shoe)).toMatchObject({ status: 'synced', variants: 2 });
    expect(view.products.find((p) => p.product_id === bare)).toMatchObject({ status: 'failed' });
  });

  it('retries an UPDATE after a 5xx: the job fails and its replay sends the update again', async () => {
    await db.query('UPDATE shop_variants SET price_minor=139900 WHERE id=$1', [v.a1]);
    graph.nextBatch = () => reply({ error: { message: 'server error', code: 2 } }, 500);
    await expect(run()).rejects.toThrow(/retrying/);
    expect(batches().map((c) => [methods(c), skus(c)])).toEqual([[['UPDATE'], ['FS-A1']]]);
    expect(batches()[0].body!.requests![0].data.price).toBe('1399.00 INR');
    expect(await item('FS-A1')).toMatchObject({ status: 'not_synced', in_meta: true, pushed_hash: null });
    // Not an uncertain outcome: no intent waits for reconciliation.
    expect(await count("SELECT count(*) AS n FROM outbound_intents WHERE account_id=$1 AND status='unknown'", [accountA])).toBe(0);
    graph.calls.length = 0;
    await runAndSettle();
    expect(batches().map((c) => [methods(c), skus(c)])).toEqual([[['UPDATE'], ['FS-A1']]]);
    expect(await item('FS-A1')).toMatchObject({ status: 'synced', attempts: 3 });
  });

  it('backs off when Meta throttles: nothing is uncertain, the items wait, and a later run is queued', async () => {
    await db.query('DELETE FROM jobs WHERE type=$1', [META_SYNC_JOB]);
    await db.query('UPDATE shop_variants SET price_minor=109900 WHERE id=$1', [v.a2]);
    await db.query('DELETE FROM jobs WHERE type=$1', [META_SYNC_JOB]);
    graph.nextBatch = () => reply({ error: { message: 'too many calls', code: 80014 } }, 400);
    const result = await run();
    expect(result).toMatchObject({ status: 'ran', batches: 0, uncertain: 0, requeued: true });
    expect(await item('FS-A2')).toMatchObject({ status: 'not_synced', in_meta: true, error_code: null });
    const queued = await syncJobs(accountA);
    expect(queued).toHaveLength(1);
    expect(new Date(queued[0].run_at).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    graph.calls.length = 0;
    await runAndSettle();
    expect(batches().map((c) => [methods(c), skus(c)])).toEqual([[['UPDATE'], ['FS-A2']]]);
    expect(await item('FS-A2')).toMatchObject({ status: 'synced' });
  });

  it('marks a CREATE that timed out uncertain and never sends it again: not on replay, not on Sync now', async () => {
    await addVariant(v.a3, 'FS-A3');
    await addVariant(v.a4, 'FS-A4');
    graph.nextBatch = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
    const result = await run();
    expect(result).toMatchObject({ status: 'ran', batches: 0, uncertain: 2 });
    expect(batches().map((c) => [methods(c), skus(c)])).toEqual([[['CREATE'], ['FS-A3', 'FS-A4']]]);
    for (const sku of ['FS-A3', 'FS-A4']) expect(await item(sku)).toMatchObject({ status: 'uncertain', method: 'CREATE', error_code: 'outcome_unknown', in_meta: false });
    const key = (await item('FS-A3')).intent_key;
    expect((await db.query('SELECT status FROM outbound_intents WHERE idempotency_key=$1', [key])).rows[0].status).toBe('unknown');

    graph.calls.length = 0;
    await run();
    await run();
    await run(accountA, { force: true });
    // Even after its content changes.
    await db.query('UPDATE shop_variants SET price_minor=51000 WHERE id=$1', [v.a3]);
    await run();
    expect(batches()).toHaveLength(0);
    expect(await item('FS-A3')).toMatchObject({ status: 'uncertain', attempts: 1 });
    const view = await withTenant(asAdmin, (tx) => getMetaSyncView(tx, accountA));
    expect(view.counts.uncertain).toBe(2);
    expect(view.problems.filter((p) => p.status === 'uncertain').map((p) => p.sku).sort()).toEqual(['FS-A3', 'FS-A4']);
    expect(view.products.find((p) => p.product_id === shoe)!.status).toBe('uncertain');
  });

  it('lets only an admin of the workspace reconcile; a failed read of Meta leaves the item uncertain', async () => {
    const later = () => new Date(Date.now() + 5 * 60_000);
    await expect(reconcileMetaItem(asAgent, v.a3, { now: later })).rejects.toBeInstanceOf(ForbiddenError);
    // RLS underneath: an agent's own UPDATE changes nothing.
    const changed = await withTenant(asAgent, (tx) => tx.$executeRaw`UPDATE shop_meta_sync_items SET status='not_synced'
      WHERE account_id=${accountA}::uuid AND variant_id=${v.a3}::uuid`).catch(() => 0);
    expect(changed).toBe(0);
    // An admin cannot push a row to any other state either (only uncertain -> synced / not_synced).
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE shop_meta_sync_items SET status='pending'
      WHERE account_id=${accountA}::uuid AND variant_id=${v.a3}::uuid`)).rejects.toThrow();
    expect(await withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE shop_meta_sync_items SET status='not_synced'
      WHERE account_id=${accountA}::uuid AND variant_id=${v.a1}::uuid`)).toBe(0);
    // Another workspace cannot see or resolve it.
    await expect(reconcileMetaItem(asOwnerB, v.a3, { now: later })).rejects.toMatchObject({ code: 'not_found' });
    // Too soon after the send: Meta may still be applying it.
    await expect(reconcileMetaItem(asAdmin, v.a3)).rejects.toMatchObject({ code: 'reconcile_too_soon' });
    graph.findFails = true;
    await expect(reconcileMetaItem(asAdmin, v.a3, { now: later })).rejects.toMatchObject({ code: 'meta_unavailable' });
    expect(await item('FS-A3')).toMatchObject({ status: 'uncertain' });
    expect(await item('FS-A1')).toMatchObject({ status: 'synced' });
    expect(batches()).toHaveLength(0);
  });

  it('reconcile settles an uncertain item from Meta, and only then is it sent again: created when missing, updated when found', async () => {
    const later = () => new Date(Date.now() + 5 * 60_000);
    graph.inMeta.set('FS-A4', '987654321');
    expect(await reconcileMetaItem(asAdmin, v.a3, { now: later })).toEqual({ status: 'not_synced' });
    expect(await reconcileMetaItem(asAdmin, v.a4, { now: later })).toEqual({ status: 'synced' });
    const lookups = graph.calls.filter((c) => c.edge === 'products');
    expect(lookups.map((c) => [c.catalog, c.auth, JSON.parse(c.url.searchParams.get('filter')!).retailer_id.eq])).toEqual(
      [[catalogA, `Bearer ${TOKEN_A}`, 'FS-A3'], [catalogA, `Bearer ${TOKEN_A}`, 'FS-A4']]);
    expect(await item('FS-A3')).toMatchObject({ status: 'not_synced', in_meta: false, pushed_hash: null, error_code: null });
    expect(await item('FS-A4')).toMatchObject({ status: 'synced', in_meta: true, meta_product_id: '987654321', pushed_hash: null });
    // Settled rows cannot be reconciled again.
    await expect(reconcileMetaItem(asAdmin, v.a3, { now: later })).rejects.toMatchObject({ code: 'conflict' });
    // The unknown intent is kept as the record of what happened; it is not cleared.
    expect(await count("SELECT count(*) AS n FROM outbound_intents WHERE account_id=$1 AND status='unknown'", [accountA])).toBe(1);

    graph.calls.length = 0;
    await runAndSettle();
    expect(batches().map((c) => [methods(c), skus(c)])).toEqual([[['UPDATE'], ['FS-A4']], [['CREATE'], ['FS-A3']]]);
    expect(await item('FS-A3')).toMatchObject({ status: 'synced', in_meta: true, attempts: 2 });
    expect(await item('FS-A4')).toMatchObject({ status: 'synced', in_meta: true, attempts: 2 });
  });

  it('recovers a run that died after claiming a batch: an old claim becomes uncertain, a fresh one is left to the run that owns it', async () => {
    await db.query('DELETE FROM jobs WHERE type=$1', [META_SYNC_JOB]);
    await db.query('UPDATE shop_meta_sync_settings SET enabled=false WHERE account_id=$1', [accountA]);
    await addVariant(v.a5, 'FS-A5');
    await addVariant(v.a6, 'FS-A6');
    const dead = `${accountA}:meta-catalogue:${catalogA}:create:${'d'.repeat(64)}`, live = `${accountA}:meta-catalogue:${catalogA}:create:${'e'.repeat(64)}`;
    await db.query(`INSERT INTO outbound_intents(account_id,idempotency_key,status,updated_at) VALUES($1,$2,'dispatching',now() - interval '10 minutes'),($1,$3,'dispatching',now())`,
      [accountA, dead, live]);
    await db.query(`INSERT INTO shop_meta_sync_items(account_id,variant_id,catalog_id,retailer_id,status,method,pushed_hash,intent_key,attempts,last_pushed_at) VALUES
      ($1,$2,$4,'FS-A5','pending','CREATE',$5,$6,1,now() - interval '10 minutes'),($1,$3,$4,'FS-A6','pending','CREATE',$5,$7,1,now())`,
      [accountA, v.a5, v.a6, catalogA, 'a'.repeat(64), dead, live]);
    await db.query('UPDATE shop_meta_sync_settings SET enabled=true WHERE account_id=$1', [accountA]);
    await run();
    await run();
    expect(batches()).toHaveLength(0);
    expect(await item('FS-A5')).toMatchObject({ status: 'uncertain', error_code: 'outcome_unknown' });
    expect((await db.query('SELECT status FROM outbound_intents WHERE idempotency_key=$1', [dead])).rows[0].status).toBe('unknown');
    expect(await item('FS-A6')).toMatchObject({ status: 'pending', batch_handle: null });
    expect((await db.query('SELECT status FROM outbound_intents WHERE idempotency_key=$1', [live])).rows[0].status).toBe('dispatching');
    // The owning run finishes: its answer is stored on the intent, and the next run picks the handle up from there.
    graph.status.set('handle-late', { handle: 'handle-late', status: 'finished', errors_total_count: 0, errors: [], ids_of_invalid_requests: [] });
    await db.query(`UPDATE outbound_intents SET status='accepted', result='{"handles":["handle-late"]}'::jsonb WHERE idempotency_key=$1`, [live]);
    await run();
    // Settled as created. The digest stored by the dead run is not today's content, so one UPDATE follows; never a second CREATE.
    expect(await item('FS-A6')).toMatchObject({ in_meta: true, method: 'UPDATE' });
    expect(batches().map((c) => [methods(c), skus(c)])).toEqual([[['UPDATE'], ['FS-A6']]]);
    await run();
    expect(await item('FS-A6')).toMatchObject({ status: 'synced', in_meta: true });
  });

  it('syncs only the picked products when the scope is "selected"', async () => {
    const extra = randomUUID(), extraVariant = randomUUID();
    await saveMetaSyncSettings(asAdmin, { scope: 'selected', select: shoe });
    await db.query("INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Picked later','published',now())", [extra, accountA]);
    await db.query("INSERT INTO shop_product_images(account_id,product_id,url,position) VALUES($1,$2,'https://cdn.example.test/extra.jpg',0)", [accountA, extra]);
    await db.query("INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory) VALUES($1,$2,$3,'FS-EXTRA',4200,false)", [extraVariant, accountA, extra]);
    await run();
    expect(batches()).toHaveLength(0);
    expect(await item('FS-EXTRA')).toBeUndefined();
    // Another workspace's product cannot be picked.
    await expect(saveMetaSyncSettings(asAdmin, { select: productB })).rejects.toMatchObject({ code: 'not_found' });
    const view = await saveMetaSyncSettings(asAdmin, { select: extra });
    expect(view.products.filter((p) => p.selected).map((p) => p.product_id).sort()).toEqual([extra, shoe].sort());
    await runAndSettle();
    expect(batches().map((c) => [methods(c), skus(c)])).toEqual([[['CREATE'], ['FS-EXTRA']]]);
    expect(await item('FS-EXTRA')).toMatchObject({ status: 'synced' });
    // Unpublishing a product that is in Meta marks it out of stock there (an UPDATE); nothing is deleted.
    graph.calls.length = 0;
    await db.query("UPDATE shop_products SET status='draft' WHERE id=$1", [extra]);
    await runAndSettle();
    expect(batches().map((c) => [methods(c), skus(c), c.body!.requests![0].data.availability])).toEqual([[['UPDATE'], ['FS-EXTRA'], 'out of stock']]);
    await saveMetaSyncSettings(asAdmin, { scope: 'all' });
  });

  it('queues "Sync now" once a minute per workspace before answering', async () => {
    await db.query('DELETE FROM jobs WHERE type=$1', [META_SYNC_JOB]);
    const now = new Date();
    await requestMetaSync(asAdmin, now);
    await requestMetaSync(asAdmin, now);
    const queued = (await syncJobs(accountA)).filter((j) => j.dedupe_key.includes(':now:'));
    expect(queued).toHaveLength(1);
    expect(queued[0].dedupe_key).toBe(`meta-catalogue-sync:${accountA}:now:${Math.floor(now.getTime() / 60_000)}`);
    expect(queued[0].payload).toEqual({ force: true });
    expect(await syncJobs(accountB)).toEqual([]);
  });

  it('does not double-send with the price and stock push: that job leaves out what this sync has in hand', async () => {
    // The mirror shows other prices for a synced variant and for one this sync could not cover (no picture).
    await db.query(`INSERT INTO products(account_id,catalog_row_id,retailer_id,name,price_minor,currency,availability) VALUES
      ($1,$2,'FS-A1','Trail shoe',100,'INR','in stock'),($1,$2,'FS-NOIMG','Bare item',100,'INR','in stock')`, [accountA, catalogRowA]);
    const pushed: MetaCatalogItemUpdate[][] = [];
    const update = vi.fn(async (args: { items: MetaCatalogItemUpdate[] }) => { pushed.push(args.items); return { handles: ['p'] }; }) as unknown as CatalogUpdater;
    await pushCatalogChanges(accountA, update);
    expect(pushed.flat().map((i) => i.retailerId)).toEqual(['FS-NOIMG']);
    // The full sync itself has nothing to send for FS-A1: its content did not change.
    await run();
    expect(batches()).toHaveLength(0);
    // With the full sync switched off, the price push covers FS-A1 again, exactly as before.
    await saveMetaSyncSettings(asAdmin, { enabled: false });
    pushed.length = 0;
    await pushCatalogChanges(accountA, update);
    expect(pushed.flat().map((i) => [i.retailerId, i.price])).toEqual([['FS-A1', '1399.00 INR']]);
  });

  it('does nothing once switched off, and never touched the other workspace', async () => {
    expect(await run()).toMatchObject({ status: 'off' });
    expect(await run(accountB)).toMatchObject({ status: 'off' });
    expect(await run(accountC)).toMatchObject({ status: 'off' });
    expect(graph.calls).toHaveLength(0);
    expect(await count('SELECT count(*) AS n FROM shop_meta_sync_items WHERE account_id=ANY($1::uuid[])', [[accountB, accountC]])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM shop_meta_sync_settings WHERE account_id=ANY($1::uuid[])', [[accountB, accountC]])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[accountB, accountC]])).toBe(0);
    const viewB = await withTenant(asOwnerB, (tx) => getMetaSyncView(tx, accountB));
    expect(viewB).toMatchObject({ connected: true, enabled: false, problems: [] });
    expect(JSON.stringify(viewB)).not.toContain('Trail shoe');
  });
});
