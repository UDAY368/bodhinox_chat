import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { createCounterSale, ensureWalkInContact, parseCounterSale, walkInContactId } from './counter-sale';
import { createManualOrder, ManualOrderError } from './manual-orders';

// Counter sale on PostgreSQL: one call makes a priced manual order and records the cash/UPI payment, so the order is
// paid, the stock committed and the receipt queued; a replay of the same request id sells and pays once; an agent
// (no record-payments permission) is refused before anything is written; another workspace's contact is refused and
// the walk-in contact is per workspace.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const contactA = randomUUID(), contactB = randomUUID();
const productA = randomUUID(), variantA = randomUUID();
let db: pg.Client;

const admin = { accountId: A, userId: adminA, role: 'admin' as const };
const agent = { accountId: A, userId: agentA, role: 'agent' as const };
const sale = (extra: Record<string, unknown> = {}, requestId = randomUUID(), qty = 1) =>
  parseCounterSale({ lines: [{ variant_id: variantA, qty }], method: 'cash', client_request_id: requestId, ...extra });
const level = async () => (await db.query('SELECT on_hand, reserved FROM inventory_levels WHERE account_id=$1 AND variant_id=$2', [A, variantA])).rows[0] as { on_hand: number; reserved: number };
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof ManualOrderError ? e.code : (e as { code?: string; name?: string }).code ?? (e as { name?: string }).name ?? 'error'));

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('counter sale on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    for (const id of [ownerA, adminA, agentA, ownerB])
      await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Counter','test-only-hash')", [id, `${id}@example.invalid`]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Counter A',$2),($3,'Counter B',$4)", [A, ownerA, B, ownerB]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [A, B]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner')",
      [A, ownerA, adminA, agentA, B, ownerB]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Asha','14155550101'),($4,$5,$6,'Other','14155550102')",
      [contactA, A, ownerA, contactB, B, ownerB]);
    await db.query("INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps) VALUES($1,'INR',true,1800),($2,'INR',true,1800)", [A, B]);
    await db.query("INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Face oil','published',now())", [productA, A]);
    await db.query("INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'OIL-15',129900)", [variantA, A, productA]);
    await db.query('INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,10)', [A, variantA]);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await db.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await db.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, adminA, agentA, ownerB]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('sells to a walk-in: a paid order, stock committed, receipt queued, payment recorded by the member', async () => {
    const input = sale({ method: 'upi', reference: 'UPI-4021' }, randomUUID(), 2);
    const before = await level();
    const result = await createCounterSale(admin, input);
    expect(result).toMatchObject({ created: true, paymentError: null });
    expect(result.paymentId).toBeTruthy();
    const order = (await db.query('SELECT source, status, contact_id::text AS contact_id, total_minor::int AS total, amount_paid_minor::int AS paid, paid_at IS NOT NULL AS has_paid_at FROM orders WHERE id=$1', [result.orderId])).rows[0];
    expect(order).toMatchObject({ source: 'manual', status: 'paid', contact_id: walkInContactId(A), total: 259800, paid: 259800, has_paid_at: true });
    const payment = (await db.query('SELECT source, method, offline_reference, recorded_by::text AS by, settlement, status FROM customer_payments WHERE id=$1', [result.paymentId])).rows[0];
    expect(payment).toEqual({ source: 'offline', method: 'upi', offline_reference: 'UPI-4021', by: adminA, settlement: 'settled', status: 'captured' });
    expect(await level()).toEqual({ on_hand: before.on_hand - 2, reserved: before.reserved });
    const receipt = await db.query("SELECT 1 FROM jobs WHERE tenant_id=$1 AND dedupe_key=$2", [A, `receipt:${result.paymentId}`]);
    expect(receipt.rowCount).toBe(1);
    const contact = (await db.query('SELECT name, phone FROM contacts WHERE id=$1 AND account_id=$2', [walkInContactId(A), A])).rows[0];
    expect(contact).toEqual({ name: 'Walk-in customer', phone: '' });
  });

  it('a replay of the same request id sells and pays once', async () => {
    const input = sale({ contact_id: contactA });
    const before = await level();
    const first = await createCounterSale(admin, input);
    const second = await createCounterSale(admin, input);
    expect(second).toEqual({ orderId: first.orderId, created: false, paymentId: first.paymentId, paymentError: null });
    expect(await level()).toEqual({ on_hand: before.on_hand - 1, reserved: before.reserved });
    expect((await db.query('SELECT count(*)::int AS n FROM orders WHERE id=$1', [first.orderId])).rows[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM customer_payments WHERE order_id=$1', [first.orderId])).rows[0].n).toBe(1);
    expect((await db.query('SELECT amount_paid_minor::int AS paid FROM orders WHERE id=$1', [first.orderId])).rows[0].paid).toBe(129900);
    expect((await db.query("SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND dedupe_key=$2", [A, `receipt:${first.paymentId}`])).rows[0].n).toBe(1);
  });

  it('a failed payment leaves an unpaid order that the same request completes', async () => {
    const input = sale({}, randomUUID());
    const before = await level();
    // The order exists (as after a first call) and a payment link whose create is unclear blocks the offline payment.
    const { orderId } = await createManualOrder(admin, { ...input.order, contactId: walkInContactId(A) }).catch(async () => {
      await ensureWalkInContact(admin);
      return createManualOrder(admin, { ...input.order, contactId: walkInContactId(A) });
    });
    const link = (await db.query("INSERT INTO payment_links(account_id,provider,reference_id,amount_minor,currency,order_id,status) VALUES($1,'razorpay',$2,129900,'INR',$3,'creating') RETURNING id",
      [A, `ref-${randomUUID()}`, orderId])).rows[0].id;
    const blocked = await createCounterSale(admin, input);
    expect(blocked).toMatchObject({ orderId, created: false, paymentId: null, paymentError: 'link_pending' });
    expect((await db.query('SELECT status FROM orders WHERE id=$1', [orderId])).rows[0].status).toBe('confirmed');
    expect(await level()).toEqual({ on_hand: before.on_hand, reserved: before.reserved + 1 });
    // Retried with the same request once the link is out of the way: paid, once.
    await db.query("UPDATE payment_links SET status='cancelled' WHERE id=$1", [link]);
    const done = await createCounterSale(admin, input);
    expect(done).toMatchObject({ orderId, created: false, paymentError: null });
    expect(done.paymentId).toBeTruthy();
    expect((await db.query('SELECT status FROM orders WHERE id=$1', [orderId])).rows[0].status).toBe('paid');
    expect(await level()).toEqual({ on_hand: before.on_hand - 1, reserved: before.reserved });
    expect(await createCounterSale(admin, input)).toMatchObject({ orderId, paymentId: done.paymentId, paymentError: null });
  });

  it('refuses an agent (no permission to record payments) before writing anything', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM orders WHERE account_id=$1', [A])).rows[0].n;
    expect(await code(createCounterSale(agent, sale()))).toBe('forbidden');
    expect((await db.query('SELECT count(*)::int AS n FROM orders WHERE account_id=$1', [A])).rows[0].n).toBe(before);
  });

  it("refuses another workspace's customer and gives each workspace its own walk-in contact", async () => {
    expect(await code(createCounterSale(admin, sale({ contact_id: contactB })))).toBe('contact_not_found');
    expect(walkInContactId(A)).not.toBe(walkInContactId(B));
    expect((await db.query('SELECT count(*)::int AS n FROM contacts WHERE account_id=$1 AND name=$2', [B, 'Walk-in customer'])).rows[0].n).toBe(0);
    // Workspace B has no catalogue entry for A's variant: the sale is refused and nothing is written there.
    const ctxB = { accountId: B, userId: ownerB, role: 'owner' as const };
    expect(await code(createCounterSale(ctxB, sale()))).toBe('variant_unavailable');
    expect((await db.query('SELECT count(*)::int AS n FROM orders WHERE account_id=$1', [B])).rows[0].n).toBe(0);
  });
});
