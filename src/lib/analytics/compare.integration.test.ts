import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { productStats } from './products';
import { campaignFunnel, flowStats, runAnalytics } from './queries';
import { parseRange } from './range';

// Phase 12 comparisons on PostgreSQL: per-product sales from the paid-order
// cohort (agents only, own workspace), campaign comparison by id (another
// workspace's id matches nothing), and flow drop-off labelled from the run's
// pinned version rather than the edited draft.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const asAgent: TenantContext = { accountId: A, userId: agentA, role: 'agent' };
const asViewer: TenantContext = { accountId: A, userId: viewerA, role: 'viewer' };
const [o1, o2, oEarly, oUnpaid, oOther] = Array.from({ length: 5 }, () => randomUUID());
const [b1, b2, bB] = Array.from({ length: 3 }, () => randomUUID());
const flow = randomUUID(), version = randomUUID(), contact = randomUUID();
const range = parseRange({ from: '2026-10-01', to: '2026-10-07' }, 'UTC', new Date('2026-11-03T00:00:00Z'));
let db: pg.Client;

const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

async function order(id: string, account: string, f: { lines: [string, number, number][]; discount: number; refunded: number; status: string;
  paidAt: string | null }) {
  const subtotal = f.lines.reduce((sum, [, qty, price]) => sum + qty * price, 0);
  const total = subtotal - f.discount;
  await q(`INSERT INTO orders(id,account_id,source,currency,subtotal_minor,discount_minor,shipping_minor,tax_minor,tax_inclusive,total_minor,
      status,priced_at,paid_at,amount_paid_minor,amount_refunded_minor)
    VALUES($1,$2,'storefront','INR',$3,$4,0,0,false,$5,$6,'2026-09-01T00:00:00Z',$7,$8,$9)`,
  [id, account, subtotal, f.discount, total, f.status, f.paidAt, f.paidAt ? total : 0, f.refunded]);
  for (const [sku, qty, price] of f.lines)
    await q(`INSERT INTO order_items(account_id,order_id,sku,name,quantity,unit_price_minor,currency,tax_minor,line_total_minor)
      VALUES($1,$2,$3,$4,$5,$6,'INR',0,$7)`, [account, id, sku, `Product ${sku}`, qty, price, qty * price]);
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('analytics comparisons on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Compare', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[ownerA, agentA, viewerA, ownerB]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Compare A',$2),($3,'Compare B',$4)", [A, ownerA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')",
      [A, ownerA, agentA, viewerA, B, ownerB]);

    // o1: 2 x A at 10.00 and 1 x B at 20.00, a 4.00 coupon, 18.00 refunded.
    await order(o1, A, { lines: [['SKU-A', 2, 1000], ['SKU-B', 1, 2000]], discount: 400, refunded: 1800, status: 'paid', paidAt: '2026-10-02T10:00:00Z' });
    await order(o2, A, { lines: [['SKU-A', 1, 1000]], discount: 0, refunded: 0, status: 'fulfilled', paidAt: '2026-10-05T10:00:00Z' });
    await order(oEarly, A, { lines: [['SKU-A', 5, 1000]], discount: 0, refunded: 0, status: 'paid', paidAt: '2026-09-20T10:00:00Z' });
    await order(oUnpaid, A, { lines: [['SKU-B', 5, 2000]], discount: 0, refunded: 0, status: 'awaiting_payment', paidAt: null });
    await order(oOther, B, { lines: [['SKU-A', 9, 1000]], discount: 0, refunded: 0, status: 'paid', paidAt: '2026-10-03T10:00:00Z' });

    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'C','919800000001')", [contact, A, ownerA]);
    await q(`INSERT INTO broadcasts(id,account_id,user_id,name,template_name,status,scheduled_at,created_at) VALUES
      ($1,$4,$5,'Spring','promo','sent','2026-08-04T07:00:00Z','2026-08-03T06:00:00Z'),
      ($2,$4,$5,'Summer','promo','sent','2026-10-04T07:00:00Z','2026-10-03T06:00:00Z'),
      ($3,$6,$7,'Other','promo','sent','2026-10-04T07:00:00Z','2026-10-03T06:00:00Z')`, [b1, b2, bB, A, ownerA, B, ownerB]);
    await q(`INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status,sent_at,delivered_at,read_at) VALUES
      ($1,$2,$4,'read','2026-08-04T07:00:00Z','2026-08-04T07:01:00Z','2026-08-04T07:02:00Z'),
      ($1,$3,$4,'delivered','2026-10-04T07:00:00Z','2026-10-04T07:01:00Z',NULL),
      ($1,$3,NULL,'failed',NULL,NULL,NULL)`, [A, b1, b2, contact]);
    await q(`INSERT INTO broadcast_recipients(account_id,broadcast_id,status,sent_at) VALUES($1,$2,'sent','2026-10-04T07:00:00Z')`, [B, bB]);

    // Published v1 asked with buttons at 'ask' and a question at 'q'; the draft
    // has since renamed 'ask' to 'ask2' (a list) and made 'q' a list.
    await q("INSERT INTO flows(id,account_id,user_id,name,trigger_type,status) VALUES($1,$2,$3,'Journey','keyword','active')", [flow, A, ownerA]);
    await q(`INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type) VALUES($1,$2,'start','start'),($1,$2,'ask2','send_list'),($1,$2,'q','send_list')`, [A, flow]);
    await q(`INSERT INTO flow_versions(id,account_id,flow_id,version,trigger_type,trigger_config,entry_node_id,fallback_policy,channel_scope,nodes)
      SELECT $1,account_id,id,1,trigger_type,trigger_config,'start',fallback_policy,'whatsapp',$3::jsonb FROM flows WHERE id=$2`,
    [version, flow, JSON.stringify([{ node_key: 'start', node_type: 'start', config: {} }, { node_key: 'ask', node_type: 'send_buttons', config: {} },
      { node_key: 'q', node_type: 'ask_question', config: {} }])]);
    await q('UPDATE flows SET published_version_id=$2 WHERE id=$1', [flow, version]);
    await q(`INSERT INTO flow_runs(account_id,flow_id,user_id,contact_id,status,current_node_key,started_at,flow_version_id) VALUES
      ($1,$2,$3,$4,'failed','ask','2026-10-02T10:00:00Z',$5), ($1,$2,$3,$4,'timed_out','q','2026-10-03T10:00:00Z',$5),
      ($1,$2,$3,$4,'timed_out','q','2026-10-03T11:00:00Z',$5), ($1,$2,$3,$4,'failed','q','2026-10-04T10:00:00Z',NULL),
      ($1,$2,$3,$4,'failed','ask2','2026-10-04T11:00:00Z',NULL)`, [A, flow, ownerA, contact, version]);
  });

  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, agentA, viewerA, ownerB]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('ranks products by net from the paid-order cohort, sharing discounts and refunds across lines', async () => {
    expect(await runAnalytics(asAgent, (tx) => productStats(tx, A, range))).toEqual([
      // A: o1 gross 2000 - 200 discount share = 1800 merch, half of the 1800 refund; o2 adds 1000.
      { key: 'SKU-A', name: 'Product SKU-A', currency: 'INR', orders: 2, units: 3, grossMinor: 3000, discountsMinor: 200, refundsMinor: 900, netMinor: 1900 },
      { key: 'SKU-B', name: 'Product SKU-B', currency: 'INR', orders: 1, units: 1, grossMinor: 2000, discountsMinor: 200, refundsMinor: 900, netMinor: 900 },
    ]);
  });

  it('shows no order lines to a viewer (RLS), whatever the route allows', async () => {
    expect(await runAnalytics(asViewer, (tx) => productStats(tx, A, range))).toEqual([]);
  });

  it('compares campaigns by id across dates, ignoring another workspace', async () => {
    const both = await runAnalytics(asViewer, (tx) => campaignFunnel(tx, A, { ids: [b1, b2] }));
    expect(both.broadcasts.map((b) => [b.name, b.recipients, b.sent, b.read, b.failed])).toEqual([['Summer', 2, 1, 0, 1], ['Spring', 1, 1, 1, 0]]);
    const cross = await runAnalytics(asViewer, (tx) => campaignFunnel(tx, A, { ids: [b1, bB] }));
    expect(cross.broadcasts.map((b) => b.name)).toEqual(['Spring']);
    // Even naming B's account in the query, A's session sees none of B's rows.
    const forged = await runAnalytics(asViewer, (tx) => campaignFunnel(tx, B, { ids: [b1, bB] }));
    expect(forged.broadcasts).toEqual([]);
  });

  it('labels drop-off from the run version, falling back to the draft for unpinned runs', async () => {
    const stats = await runAnalytics(asViewer, (tx) => flowStats(tx, A, range, flow));
    expect(stats.dropOff).toEqual([
      { flowId: flow, nodeKey: 'q', nodeType: 'ask_question', runs: 3 },
      { flowId: flow, nodeKey: 'ask', nodeType: 'send_buttons', runs: 1 },
      { flowId: flow, nodeKey: 'ask2', nodeType: 'send_list', runs: 1 },
    ]);
  });
});
