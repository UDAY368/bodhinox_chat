import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';

// Store Phase 5 on PostgreSQL: editing an order before dispatch, and split shipments. Real rows, RLS, grants,
// triggers and jobs; the only fakes are Razorpay's link create (a row is written the way the real call would) and
// the courier adapter's cancel. The gates: another workspace cannot edit or split, a viewer is refused, a stale
// version is a conflict, the stock hold or the sold units follow the edit, a refund or a balance link is made
// exactly once however often the same edit is replayed, an issued tax invoice is never changed, a line never
// ships beyond its ordered quantity, a cancelled parcel frees its quantities, and the order moves to partially
// shipped, dispatched and delivered from its parcels.
const h = vi.hoisted(() => ({ createLink: vi.fn(), cancel: vi.fn(async () => undefined) }));
vi.mock('@/lib/payments/links', async (original) => ({
  ...(await original<typeof import('@/lib/payments/links')>()), createPaymentLinkRecord: h.createLink,
}));
vi.mock('@/lib/fulfilment/providers', async (original) => {
  const actual = await original<typeof import('@/lib/fulfilment/providers')>();
  const fake = { id: 'shiprocket', name: 'Shiprocket', requiresPickup: true, disabled: () => false, cancel: h.cancel };
  return { ...actual, getCourierProvider: () => fake, allCourierProviders: () => [fake] };
});

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const contactA = randomUUID(), connectionA = randomUUID();
const productA = randomUUID(), V1 = randomUUID(), V2 = randomUUID(), productB = randomUUID(), VB = randomUUID();
const owner = { accountId: A, userId: ownerA, role: 'owner' as const };
const agent = { accountId: A, userId: agentA, role: 'agent' as const };
const viewer = { accountId: A, userId: viewerA, role: 'viewer' as const };
const otherOwner = { accountId: B, userId: ownerB, role: 'owner' as const };
const ADDRESS = { name: 'Asha Rao', phone: '+91 98765 43210', line1: '12 MG Road', line2: null, city: 'Bengaluru', state: 'Karnataka',
  state_code: 'KA', postal_code: '560001', country: 'IN', instructions: null };
const DIMS = { length_cm: 20, breadth_cm: 15, height_cm: 10 };

let db: pg.Client;
let edits: typeof import('./order-edits');
let manual: typeof import('./manual-orders');
let offline: typeof import('@/lib/payments/offline');
let shipments: typeof import('@/lib/fulfilment/shipments');
let lifecycle: typeof import('./order-lifecycle');
let settle: typeof import('@/lib/payments/settle');
let reference: typeof import('./order-edit-reference');

const one = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows[0];
const level = async (variant: string) => (await one('SELECT on_hand, reserved FROM inventory_levels WHERE account_id=$1 AND variant_id=$2', [A, variant])) as { on_hand: number; reserved: number };
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e as { code?: string }).code ?? (e as { name?: string }).name ?? 'error');
const orderRow = (id: string) => one(`SELECT status, total_minor::int AS total, subtotal_minor::int AS subtotal, edit_version AS version,
  amount_paid_minor::int AS paid, amount_refunded_minor::int AS refunded FROM orders WHERE id=$1`, [id]);
const itemsOf = async (id: string) => (await db.query(`SELECT variant_id::text AS variant, quantity, line_total_minor::int AS total FROM order_items
  WHERE order_id=$1 ORDER BY unit_price_minor DESC`, [id])).rows;

async function newOrder(lines: Array<[string, number]>): Promise<string> {
  const { orderId } = await manual.createManualOrder(agent, manual.parseManualOrder({
    contact_id: contactA, client_request_id: randomUUID(), lines: lines.map(([variant_id, qty]) => ({ variant_id, qty })),
  }));
  return orderId;
}

/** Pay the order in full (recorded by staff), then, for `gateway`, make that payment one Razorpay holds. */
async function pay(orderId: string, gateway: boolean): Promise<void> {
  const { total } = await orderRow(orderId);
  await offline.recordOfflinePayment(owner, orderId, { amount: (total / 100).toFixed(2), method: 'cash', reference: null, clientRequestId: randomUUID() });
  if (gateway) await db.query("UPDATE customer_payments SET source='razorpay', provider_payment_id=$2 WHERE order_id=$1",
    [orderId, `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`]);
}

const input = (version: number, lines: Array<[string, number]>, extra: Record<string, unknown> = {}) => edits.parseOrderEdit({
  expected_version: version, lines: lines.map(([variant_id, qty]) => ({ variant_id, qty })), reason: 'Customer asked on a call',
  client_request_id: randomUUID(), ...extra,
});

/** A storefront-style paid order with an address, inserted directly (shipments need the address; edits are not used on it). */
async function shippableOrder(): Promise<{ id: string; a: string; b: string }> {
  const id = randomUUID(), a = randomUUID(), b = randomUUID();
  await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,shipping_minor,tax_minor,tax_inclusive,total_minor,
      status,priced_at,paid_at,amount_paid_minor,shipping_address) VALUES($1,$2,'storefront',$3,'INR',350000,0,0,true,350000,'paid',now(),now(),350000,$4)`,
  [id, A, contactA, JSON.stringify(ADDRESS)]);
  await db.query(`INSERT INTO order_items(id,account_id,order_id,name,sku,quantity,unit_price_minor,currency,variant_id,tax_rate_bps,line_total_minor)
    VALUES($1,$3,$4,'Face oil','OIL-15',3,100000,'INR',$5,1800,300000),($2,$3,$4,'Hair oil','OIL-30',1,50000,'INR',$6,1800,50000)`,
  [a, b, A, id, V1, V2]);
  return { id, a, b };
}

const shipmentRows = async (orderId: string) => (await db.query(`SELECT s.id::text AS id, s.create_state, s.weight_grams,
    COALESCE((SELECT json_agg(json_build_object('item', x.order_item_id::text, 'qty', x.quantity) ORDER BY x.quantity DESC)
      FROM shipment_items x WHERE x.shipment_id=s.id), '[]'::json) AS items
  FROM order_shipments s WHERE s.order_id=$1 ORDER BY s.created_at, s.id`, [orderId])).rows as Array<{ id: string; create_state: string; weight_grams: number; items: Array<{ item: string; qty: number }> }>;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('order edits and split shipments on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    for (const id of [ownerA, agentA, viewerA, ownerB])
      await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Edit','test-only-hash')", [id, `${id}@example.invalid`]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Edit A',$2),($3,'Edit B',$4)", [A, ownerA, B, ownerB]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')",
      [A, ownerA, agentA, viewerA, B, ownerB]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Asha','919876543210')", [contactA, A, ownerA]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps)
      VALUES($1,'INR',true,1800),($2,'INR',true,1800)`, [A, B]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES
      ($1,$2,'Face oil','published',now()),($3,$4,'Other shop oil','published',now())`, [productA, A, productB, B]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,weight_grams) VALUES
      ($1,$2,$3,'OIL-15',100000,200),($4,$2,$3,'OIL-30',50000,300),($5,$6,$7,'B-OIL',100,NULL)`, [V1, A, productA, V2, VB, B, productB]);
    await db.query('INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,100),($1,$3,3),($4,$5,5)', [A, V1, V2, B, VB]);
    await db.query(`INSERT INTO courier_connections(id,account_id,provider,api_email,pickup_location) VALUES($1,$2,'shiprocket','api@example.invalid','Primary')`,
      [connectionA, A]);
    edits = await import('./order-edits');
    manual = await import('./manual-orders');
    offline = await import('@/lib/payments/offline');
    shipments = await import('@/lib/fulfilment/shipments');
    lifecycle = await import('./order-lifecycle');
    settle = await import('@/lib/payments/settle');
    reference = await import('./order-edit-reference');
  });

  beforeEach(() => {
    h.cancel.mockClear();
    h.createLink.mockReset();
    // Razorpay's create, as the real one behaves for a reference: one row per reference, the same row on a replay.
    h.createLink.mockImplementation(async (args: { accountId: string; referenceId: string; amountMinor: number; currency: string; orderId: string }) => {
      const existing = await one('SELECT id::text AS id, status FROM payment_links WHERE reference_id=$1', [args.referenceId]);
      if (existing) return { link: existing, outcome: 'existing' };
      const link = await one(`INSERT INTO payment_links(account_id,provider,provider_link_id,reference_id,short_url,amount_minor,currency,order_id,status)
        VALUES($1,'razorpay',$2,$3,'https://rzp.io/i/test',$4,$5,$6,'created') RETURNING id::text AS id, status`,
      [args.accountId, `plink_${randomUUID().replace(/-/g, '').slice(0, 14)}`, args.referenceId, args.amountMinor, args.currency, args.orderId]);
      return { link, outcome: 'created' };
    });
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await db.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await db.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, agentA, viewerA, ownerB]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('refuses a viewer, another workspace, and another workspace\'s variant', async () => {
    const orderId = await newOrder([[V1, 2]]);
    expect(await code(edits.editOrder(viewer, orderId, input(0, [[V1, 3]])))).toBe('forbidden');
    expect(await code(edits.previewOrderEdit(viewer, orderId, input(0, [[V1, 3]])))).toBe('forbidden');
    expect(await code(edits.editOrder(otherOwner, orderId, input(0, [[V1, 3]])))).toBe('not_found');
    expect(await code(edits.getOrderEditState(otherOwner, orderId))).toBe('not_found');
    expect(await code(edits.editOrder(agent, orderId, input(0, [[V1, 2], [VB, 1]])))).toBe('variant_unavailable');
    expect(await orderRow(orderId)).toMatchObject({ total: 200000, version: 0 });
    expect((await one('SELECT count(*)::int AS n FROM order_edits WHERE order_id=$1', [orderId])).n).toBe(0);
  });

  it('edits an unpaid order: reprices on the server, moves the stock hold, records the edit, and replays once', async () => {
    const orderId = await newOrder([[V1, 2]]);
    const before = { v1: await level(V1), v2: await level(V2) };
    const preview = await edits.previewOrderEdit(agent, orderId, input(0, [[V1, 3], [V2, 1]]));
    expect(preview).toMatchObject({ version: 0, before: { total_minor: 200000 }, after: { total_minor: 350000 }, payment: { action: 'none', difference_minor: 0 } });
    expect(await orderRow(orderId)).toMatchObject({ total: 200000, version: 0 });

    const edit = input(0, [[V1, 3], [V2, 1]]);
    const saved = await edits.editOrder(agent, orderId, edit);
    expect(saved).toMatchObject({ created: true, payment_action: 'none' });
    expect(await orderRow(orderId)).toMatchObject({ status: 'confirmed', total: 350000, subtotal: 350000, version: 1 });
    expect(await itemsOf(orderId)).toEqual([{ variant: V1, quantity: 3, total: 300000 }, { variant: V2, quantity: 1, total: 50000 }]);
    expect(await level(V1)).toEqual({ on_hand: before.v1.on_hand, reserved: before.v1.reserved + 1 });
    expect(await level(V2)).toEqual({ on_hand: before.v2.on_hand, reserved: before.v2.reserved + 1 });
    const row = await one(`SELECT actor_user_id::text AS actor, reason, payment_action, payment_state, total_before_minor::int AS was,
      total_after_minor::int AS now, lines_before, lines_after, version_after FROM order_edits WHERE id=$1`, [saved.editId]);
    expect(row).toMatchObject({ actor: agentA, reason: 'Customer asked on a call', payment_action: 'none', payment_state: 'none', was: 200000, now: 350000, version_after: 1 });
    expect(row.lines_before).toHaveLength(1);
    expect(row.lines_after).toHaveLength(2);
    expect((await one("SELECT count(*)::int AS n FROM order_events WHERE order_id=$1 AND kind='order_edited' AND actor_user_id=$2", [orderId, agentA])).n).toBe(1);
    expect((await one("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='order.edited' AND resource_id=$2", [A, orderId])).n).toBe(1);

    // The same request again: the edit it already made, nothing moves twice.
    expect(await edits.editOrder(agent, orderId, edit)).toMatchObject({ editId: saved.editId, created: false });
    expect(await orderRow(orderId)).toMatchObject({ total: 350000, version: 1 });
    expect(await level(V1)).toEqual({ on_hand: before.v1.on_hand, reserved: before.v1.reserved + 1 });

    // A stale version is refused; so is more than the free stock, and nothing is left half done.
    expect(await code(edits.editOrder(agent, orderId, input(0, [[V1, 1]])))).toBe('conflict');
    expect(await code(edits.editOrder(agent, orderId, input(1, [[V1, 3], [V2, 9]])))).toBe('out_of_stock');
    expect(await code(edits.editOrder(agent, orderId, input(1, [[V1, 3], [V2, 1]])))).toBe('no_change');
    expect(await orderRow(orderId)).toMatchObject({ total: 350000, version: 1 });
    expect(await level(V2)).toEqual({ on_hand: before.v2.on_hand, reserved: before.v2.reserved + 1 });

    // Reduce one line and remove the other: the hold shrinks, the removed line is gone.
    await edits.editOrder(agent, orderId, input(1, [[V1, 1]]));
    expect(await orderRow(orderId)).toMatchObject({ total: 100000, version: 2 });
    expect(await itemsOf(orderId)).toEqual([{ variant: V1, quantity: 1, total: 100000 }]);
    expect(await level(V1)).toEqual({ on_hand: before.v1.on_hand, reserved: before.v1.reserved - 1 });
    expect(await level(V2)).toEqual(before.v2);
    // Cancelling afterwards releases exactly what the edited order holds.
    await lifecycle.transitionOrder(agent, orderId, { from: 'confirmed', to: 'cancelled' });
    expect(await level(V1)).toEqual({ on_hand: before.v1.on_hand, reserved: before.v1.reserved - 2 });
    expect(await code(edits.editOrder(agent, orderId, input(2, [[V1, 2]])))).toBe('not_editable');
  });

  it('lets only one of two concurrent edits of the same version through', async () => {
    const orderId = await newOrder([[V1, 1]]);
    const results = await Promise.all([code(edits.editOrder(agent, orderId, input(0, [[V1, 2]]))), code(edits.editOrder(agent, orderId, input(0, [[V1, 3]])))]);
    expect(results.sort()).toEqual(['conflict', 'ok']);
    expect((await orderRow(orderId)).version).toBe(1);
    expect((await one('SELECT count(*)::int AS n FROM order_edits WHERE order_id=$1', [orderId])).n).toBe(1);
  });

  it('keeps the priced freeze for everything that is not an order edit', async () => {
    const orderId = await newOrder([[V1, 1]]);
    const worker = getWorkerPrisma();
    await expect(withTenant({ accountId: A, role: 'owner' }, (tx) => tx.$executeRaw`UPDATE orders SET total_minor=1 WHERE id=${orderId}::uuid`, worker)).rejects.toThrow();
    await expect(withTenant({ accountId: A, role: 'owner' }, (tx) => tx.$executeRaw`UPDATE order_items SET quantity=9 WHERE order_id=${orderId}::uuid`, worker)).rejects.toThrow();
    await expect(withTenant({ accountId: A, role: 'owner' }, (tx) => tx.$executeRaw`DELETE FROM order_items WHERE order_id=${orderId}::uuid`, worker)).rejects.toThrow();
    // Naming the order in the setting is not enough for a browser session (the app role).
    await expect(withTenant(owner, async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.order_edit', ${orderId}, true)`;
      await tx.$executeRaw`UPDATE order_items SET quantity=9 WHERE order_id=${orderId}::uuid`;
    })).rejects.toThrow();
    // Even inside an edit the line's identity and price stay frozen.
    await expect(withTenant({ accountId: A, role: 'owner' }, async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.order_edit', ${orderId}, true)`;
      await tx.$executeRaw`UPDATE order_items SET unit_price_minor=1 WHERE order_id=${orderId}::uuid`;
    }, worker)).rejects.toThrow();
    expect(await itemsOf(orderId)).toEqual([{ variant: V1, quantity: 1, total: 100000 }]);
  });

  it('keeps the delivery method, store credit and points frozen even inside an edit, and refuses an order the edit cannot reprice', async () => {
    const orderId = await newOrder([[V1, 1]]);
    const worker = getWorkerPrisma();
    const inEdit = (change: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<unknown>) => withTenant({ accountId: A, role: 'owner' }, async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.order_edit', ${orderId}, true)`;
      await change(tx);
    }, worker);
    await expect(inEdit((tx) => tx.$executeRaw`UPDATE orders SET delivery_method='pickup' WHERE id=${orderId}::uuid`)).rejects.toThrow();
    await expect(inEdit((tx) => tx.$executeRaw`UPDATE orders SET store_credit_minor=1 WHERE id=${orderId}::uuid`)).rejects.toThrow();
    await expect(inEdit((tx) => tx.$executeRaw`UPDATE orders SET points_redeemed=1, points_value_minor=1 WHERE id=${orderId}::uuid`)).rejects.toThrow();
    // The amounts do move inside an edit, and only there (the edit tests above and below go through this).
    await inEdit((tx) => tx.$executeRaw`UPDATE orders SET edit_version=edit_version+1 WHERE id=${orderId}::uuid`);
    await expect(withTenant({ accountId: A, role: 'owner' }, (tx) => tx.$executeRaw`UPDATE orders SET edit_version=edit_version+1 WHERE id=${orderId}::uuid`, worker)).rejects.toThrow();

    // Priced by checkout with what an edit does not reprice: pickup, store credit, a free gift.
    const placed = async (orderColumns: string, orderValues: string, gift = false) => {
      const id = randomUUID();
      await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,shipping_minor,tax_minor,tax_inclusive,total_minor,
          status,priced_at,shipping_address${orderColumns}) VALUES($1,$2,'storefront',$3,'INR',100000,0,0,true,100000,'confirmed',now(),$4${orderValues})`,
      [id, A, contactA, JSON.stringify(ADDRESS)]);
      await db.query(`INSERT INTO order_items(account_id,order_id,name,sku,quantity,unit_price_minor,currency,variant_id,tax_rate_bps,line_total_minor,is_gift)
        VALUES($1,$2,'Face oil','OIL-15',1,100000,'INR',$3,1800,100000,$4)`, [A, id, V1, gift]);
      return id;
    };
    const plain = await placed('', '');
    expect((await edits.getOrderEditState(agent, plain)).blocked).toBeNull();
    for (const id of [await placed(',delivery_method', ",'pickup'"), await placed(',store_credit_minor', ',5000'), await placed('', '', true)]) {
      expect(await code(edits.previewOrderEdit(agent, id, input(0, [[V1, 2]])))).toBe('not_editable');
      expect(await code(edits.editOrder(agent, id, input(0, [[V1, 2]])))).toBe('not_editable');
      expect((await edits.getOrderEditState(agent, id)).blocked).toBe('not_editable');
      expect(await itemsOf(id)).toEqual([{ variant: V1, quantity: 1, total: 100000 }]);
    }
  });

  it('refunds the difference of a paid order through the gateway exactly once, and restocks the units', async () => {
    const orderId = await newOrder([[V1, 2]]);
    await pay(orderId, true);
    const before = await level(V1);
    // An agent may edit, but not an edit that refunds (commerce.refunds).
    expect(await code(edits.editOrder(agent, orderId, input(0, [[V1, 1]])))).toBe('forbidden');
    expect(await orderRow(orderId)).toMatchObject({ total: 200000, version: 0 });

    const edit = input(0, [[V1, 1]]);
    expect(await edits.previewOrderEdit(owner, orderId, edit)).toMatchObject({ payment: { action: 'refund', difference_minor: 100000, needs_outside_confirmation: false } });
    const saved = await edits.editOrder(owner, orderId, edit);
    expect(saved).toMatchObject({ created: true, payment_action: 'refund' });
    expect(await orderRow(orderId)).toMatchObject({ status: 'paid', total: 100000, version: 1, paid: 200000 });
    expect(await level(V1)).toEqual({ on_hand: before.on_hand + 1, reserved: before.reserved });
    const refunds = async () => (await db.query("SELECT id::text AS id, amount_minor::int AS amount, status, source, restock FROM customer_refunds WHERE order_id=$1", [orderId])).rows;
    expect(await refunds()).toEqual([expect.objectContaining({ amount: 100000, status: 'requested', source: 'bodhinox', restock: false })]);
    const refundId = (await refunds())[0].id;
    const jobs = async () => (await one("SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND type='payments.refund' AND dedupe_key=$2", [A, `refund:${refundId}:1`])).n;
    expect(await jobs()).toBe(1);
    expect(await one('SELECT payment_state, refund_ids::text[] AS ids FROM order_edits WHERE id=$1', [saved.editId])).toEqual({ payment_state: 'refund_requested', ids: [refundId] });

    // Replayed (a double click, a retried request): the same edit, one refund, one job, the stock untouched.
    expect(await edits.editOrder(owner, orderId, edit)).toMatchObject({ editId: saved.editId, created: false });
    expect(await refunds()).toHaveLength(1);
    expect(await jobs()).toBe(1);
    expect(await level(V1)).toEqual({ on_hand: before.on_hand + 1, reserved: before.reserved });
    // While that refund is in flight the order is not edited again.
    expect(await code(edits.editOrder(owner, orderId, input(1, [[V1, 3]])))).toBe('refund_in_flight');
    expect((await edits.getOrderEditState(owner, orderId)).blocked).toBe('refund_in_flight');
  });

  it('needs the member\'s confirmation before money Razorpay does not hold counts as returned', async () => {
    const orderId = await newOrder([[V1, 3]]);
    await pay(orderId, false);
    expect(await edits.previewOrderEdit(owner, orderId, input(0, [[V1, 2]]))).toMatchObject({ payment: { action: 'refund', needs_outside_confirmation: true } });
    expect(await code(edits.editOrder(owner, orderId, input(0, [[V1, 2]])))).toBe('offline_payment');
    expect(await orderRow(orderId)).toMatchObject({ total: 300000, version: 0, refunded: 0 });
    const saved = await edits.editOrder(owner, orderId, input(0, [[V1, 2]], { refunded_outside: true }));
    expect(await orderRow(orderId)).toMatchObject({ total: 200000, version: 1, paid: 300000, refunded: 100000 });
    expect(await one('SELECT payment_state FROM order_edits WHERE id=$1', [saved.editId])).toEqual({ payment_state: 'refund_outside' });
    expect((await one("SELECT status, source FROM customer_refunds WHERE order_id=$1", [orderId]))).toEqual({ status: 'processed', source: 'external' });
  });

  it('asks for the balance of a paid order with one payment link, credits it once paid, and never links twice', async () => {
    const orderId = await newOrder([[V1, 1]]);
    await pay(orderId, true);
    const before = await level(V1);
    const edit = input(0, [[V1, 2]]);
    expect(await edits.previewOrderEdit(agent, orderId, edit)).toMatchObject({ payment: { action: 'collect', difference_minor: 100000 } });
    const saved = await edits.editOrder(agent, orderId, edit);
    expect(saved).toMatchObject({ created: true, payment_action: 'collect' });
    expect(await orderRow(orderId)).toMatchObject({ status: 'paid', total: 200000, paid: 100000, version: 1 });
    expect(await level(V1)).toEqual({ on_hand: before.on_hand - 1, reserved: before.reserved });
    const links = async () => (await db.query('SELECT id::text AS id, reference_id, amount_minor::int AS amount, status FROM payment_links WHERE order_id=$1', [orderId])).rows;
    expect(await links()).toEqual([expect.objectContaining({ reference_id: reference.editBalanceReference(saved.editId, 1), amount: 100000, status: 'created' })]);
    const state = await edits.getOrderEditState(agent, orderId);
    expect(state).toMatchObject({ version: 1, balance_due_minor: 100000, blocked: 'payment_link_open' });
    expect(state.edits[0]).toMatchObject({ payment_action: 'collect', payment_state: 'link_created', payment_link_url: 'https://rzp.io/i/test', difference_minor: 100000 });

    // The same edit again, and the admin asking for the link again: still one link.
    expect(await edits.editOrder(agent, orderId, edit)).toMatchObject({ created: false });
    expect(await edits.ensureBalanceLink(agent, orderId, saved.editId)).toBe('link_created');
    expect(await links()).toHaveLength(1);
    expect(await level(V1)).toEqual({ on_hand: before.on_hand - 1, reserved: before.reserved });
    // The old amount could still be paid through that link: no further edit until it is paid or cancelled.
    expect(await code(edits.editOrder(agent, orderId, input(1, [[V1, 3]])))).toBe('payment_link_open');

    // The customer pays the link: the balance is credited to the order, once, and the order stays paid.
    const link = (await links())[0];
    const verified = { accountId: A, paymentLinkId: link.id, providerPaymentId: `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`, providerKeyId: null,
      providerAccountId: null, amountMinor: 100000, currency: 'INR', status: 'captured' as const, method: 'upi', capturedAt: new Date() };
    const settleOnce = () => withTenant({ accountId: A, role: 'owner' }, (tx) => settle.settlePaymentTx(tx, verified), getWorkerPrisma());
    expect(await settleOnce()).toMatchObject({ kind: 'settled' });
    expect(await settleOnce()).toMatchObject({ kind: 'duplicate' });
    expect(await orderRow(orderId)).toMatchObject({ status: 'paid', total: 200000, paid: 200000 });
    expect(await one('SELECT payment_state FROM order_edits WHERE id=$1', [saved.editId])).toEqual({ payment_state: 'link_paid' });
    expect((await one("SELECT count(*)::int AS n FROM payment_exceptions WHERE account_id=$1 AND order_id=$2", [A, orderId])).n).toBe(0);
    expect((await edits.getOrderEditState(agent, orderId)).balance_due_minor).toBe(0);
  });

  it('surfaces a balance link Razorpay could not make, and makes it when asked again', async () => {
    const orderId = await newOrder([[V1, 1]]);
    await pay(orderId, true);
    const { PaymentLinkError } = await import('@/lib/payments/links');
    h.createLink.mockImplementationOnce(async () => { throw new PaymentLinkError('not_connected'); });
    const saved = await edits.editOrder(agent, orderId, input(0, [[V1, 2]]));
    // The edit stands; the order shows the balance and why no link exists.
    expect(await orderRow(orderId)).toMatchObject({ total: 200000, paid: 100000, version: 1 });
    const state = await edits.getOrderEditState(agent, orderId);
    expect(state.balance_due_minor).toBe(100000);
    expect(state.edits[0]).toMatchObject({ payment_state: 'link_failed', failure_code: 'not_connected', payment_link_url: null });
    expect((await one('SELECT count(*)::int AS n FROM payment_links WHERE order_id=$1', [orderId])).n).toBe(0);
    expect(await edits.ensureBalanceLink(agent, orderId, saved.editId)).toBe('link_created');
    expect((await one('SELECT count(*)::int AS n FROM payment_links WHERE order_id=$1', [orderId])).n).toBe(1);
    expect(await code(edits.ensureBalanceLink(otherOwner, orderId, saved.editId))).toBe('not_found');
  });

  it('never changes an issued tax invoice: only a decrease that refunds is allowed', async () => {
    const invoice = (orderId: string, n: number) => db.query(`INSERT INTO commerce_documents(account_id,order_id,kind,number,fy,currency,seller,buyer,line_items,
        subtotal_minor,total_minor) VALUES($1,$2,'tax_invoice',$3,'2026-27','INR','{}','{}','[]',100000,100000)`, [A, orderId, `INV/2026-27/${n}`]);
    const unpaid = await newOrder([[V1, 1]]);
    await invoice(unpaid, 9001);
    expect(await code(edits.editOrder(owner, unpaid, input(0, [[V1, 2]])))).toBe('invoice_issued');

    const paid = await newOrder([[V1, 2]]);
    await pay(paid, true);
    await invoice(paid, 9002);
    expect(await code(edits.editOrder(owner, paid, input(0, [[V1, 3]])))).toBe('invoice_issued');
    expect(await orderRow(paid)).toMatchObject({ total: 200000, version: 0 });
    // A decrease refunds; the refund path issues the credit note. The invoice row itself is untouched.
    expect(await edits.editOrder(owner, paid, input(0, [[V1, 1]]))).toMatchObject({ payment_action: 'refund' });
    expect(await one("SELECT total_minor::int AS total FROM commerce_documents WHERE order_id=$1 AND kind='tax_invoice'", [paid])).toEqual({ total: 100000 });
  });

  it('splits an order into shipments, never over-ships a line, and frees a cancelled parcel\'s quantities', async () => {
    const { id, a, b } = await shippableOrder();
    // Another workspace cannot see the order; an agent cannot create shipments (commerce.shipments).
    expect(await code(shipments.requestShipment(otherOwner, id, { ...DIMS, weight_grams: 500 }))).toBe('not_connected');
    await db.query(`INSERT INTO courier_connections(account_id,provider,api_email,pickup_location) VALUES($1,'shiprocket','b@example.invalid','Primary')`, [B]);
    expect(await code(shipments.requestShipment(otherOwner, id, { ...DIMS, weight_grams: 500 }))).toBe('not_found');
    expect(await code(shipments.cancelShipment(otherOwner, id))).toBe('not_found');
    expect(await code(shipments.requestShipment(agent, id, { ...DIMS, weight_grams: 500 }))).toBe('forbidden');
    expect(await code(shipments.requestShipment(owner, id, { ...DIMS, weight_grams: null }, null, [{ orderItemId: a, quantity: 4 }]))).toBe('over_shipped');
    expect(await code(shipments.requestShipment(owner, id, { ...DIMS, weight_grams: null }, null, [{ orderItemId: randomUUID(), quantity: 1 }]))).toBe('invalid');

    // Parcel 1: two of the three face oils; its weight comes from its own items (2 x 200 g).
    const first = await shipments.requestShipment(owner, id, { ...DIMS, weight_grams: null }, null, [{ orderItemId: a, quantity: 2 }]);
    expect(await shipmentRows(id)).toEqual([{ id: first.shipmentId, create_state: 'creating', weight_grams: 400, items: [{ item: a, qty: 2 }] }]);
    expect((await one("SELECT detail FROM order_events WHERE order_id=$1 AND kind='shipment_created'", [id])).detail).toBe('partial');
    // Only one face oil remains: two more is refused.
    expect(await code(shipments.requestShipment(owner, id, { ...DIMS, weight_grams: null }, null, [{ orderItemId: a, quantity: 2 }]))).toBe('over_shipped');
    // Parcel 2 with no items named: everything that remains (the single-shipment path), then nothing is left.
    const second = await shipments.requestShipment(owner, id, { ...DIMS, weight_grams: 650 });
    expect((await shipmentRows(id))[1]).toEqual({ id: second.shipmentId, create_state: 'creating', weight_grams: 650, items: expect.arrayContaining([{ item: a, qty: 1 }, { item: b, qty: 1 }]) });
    expect(await code(shipments.requestShipment(owner, id, { ...DIMS, weight_grams: 500 }))).toBe('shipment_exists');
    const lines = await withTenant(owner, (tx) => shipments.orderLinesShipped(tx, A, id));
    expect(lines.map((l) => [l.id, l.shipped]).sort()).toEqual([[a, 3], [b, 1]].sort());

    // Cancelling parcel 1 (the courier holds it, not picked up) frees its two units for a new parcel.
    await db.query("UPDATE order_shipments SET create_state='created', sr_order_id='7001', sr_shipment_id='7002' WHERE id=$1", [first.shipmentId]);
    await shipments.cancelShipment(owner, id, first.shipmentId);
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect((await shipmentRows(id)).map((s) => s.create_state)).toEqual(['cancelled', 'creating']);
    expect(await code(shipments.requestShipment(owner, id, { ...DIMS, weight_grams: null }, null, [{ orderItemId: a, quantity: 3 }]))).toBe('over_shipped');
    const third = await shipments.requestShipment(owner, id, { ...DIMS, weight_grams: null }, null, [{ orderItemId: a, quantity: 2 }]);
    expect((await shipmentRows(id)).find((s) => s.id === third.shipmentId)).toMatchObject({ weight_grams: 400, items: [{ item: a, qty: 2 }] });
    // The app reads every parcel with its lines; another workspace reads none.
    expect((await withTenant(owner, (tx) => shipments.listOrderShipments(tx, A, id))).map((s) => s.items?.length)).toEqual([1, 2, 1]);
    expect(await withTenant(otherOwner, (tx) => shipments.listOrderShipments(tx, B, id))).toEqual([]);
  });

  it('moves the order to partially shipped, dispatched and delivered from its parcels', async () => {
    const { id, a, b } = await shippableOrder();
    const first = await shipments.requestShipment(owner, id, { ...DIMS, weight_grams: null }, null, [{ orderItemId: a, quantity: 3 }]);
    const second = await shipments.requestShipment(owner, id, { ...DIMS, weight_grams: null }, null, [{ orderItemId: b, quantity: 1 }]);
    const system = <T>(fn: (tx: Parameters<typeof lifecycle.systemDispatch>[0]) => Promise<T>) => withTenant({ accountId: A }, fn, getWorkerPrisma());
    const status = async () => (await orderRow(id)).status;

    // The courier picked up parcel 1 only.
    await db.query('UPDATE order_shipments SET provider_dispatched_at=now() WHERE id=$1', [first.shipmentId]);
    expect(await system((tx) => lifecycle.systemDispatch(tx, A, id))).toBe('applied');
    expect(await status()).toBe('partially_shipped');
    expect(await system((tx) => lifecycle.systemDispatch(tx, A, id))).toBe('already');
    expect((await one("SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND dedupe_key=$2", [A, `ofu:${id}:dispatched`])).n).toBe(1);
    // Parcel 1 delivered while parcel 2 has not left: the order is not delivered.
    await db.query("UPDATE order_shipments SET tracking_status='delivered', provider_delivered_at=now() WHERE id=$1", [first.shipmentId]);
    expect(await system((tx) => lifecycle.systemDeliver(tx, A, id))).toBe('already');
    expect(await status()).toBe('partially_shipped');
    // A new parcel may still be created for a partially shipped order only if something remains: nothing does here.
    expect(await code(shipments.requestShipment(owner, id, { ...DIMS, weight_grams: 500 }))).toBe('shipment_exists');
    // Parcel 2 leaves: everything is shipped.
    await db.query('UPDATE order_shipments SET provider_dispatched_at=now() WHERE id=$1', [second.shipmentId]);
    expect(await system((tx) => lifecycle.systemDispatch(tx, A, id))).toBe('applied');
    expect(await status()).toBe('dispatched');
    // Parcel 2 delivered too: the order is delivered, with its follow-ups queued once.
    await db.query("UPDATE order_shipments SET tracking_status='delivered', provider_delivered_at=now() WHERE id=$1", [second.shipmentId]);
    expect(await system((tx) => lifecycle.systemDeliver(tx, A, id))).toBe('applied');
    expect(await status()).toBe('fulfilled');
    expect((await one("SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND dedupe_key=$2", [A, `ofu:${id}:delivered`])).n).toBe(1);
    const history = (await db.query("SELECT to_status FROM order_events WHERE order_id=$1 AND kind='status_changed' ORDER BY created_at, id", [id])).rows.map((r) => r.to_status);
    expect(history).toEqual(expect.arrayContaining(['partially_shipped', 'dispatched', 'fulfilled']));
  });

  it('after a partial shipment, lets an edit reduce only what has not shipped', async () => {
    const orderId = await newOrder([[V1, 3]]);
    await pay(orderId, false);
    const item = (await one('SELECT id::text AS id FROM order_items WHERE order_id=$1', [orderId])).id as string;
    const shipmentId = randomUUID();
    await db.query(`INSERT INTO order_shipments(id,account_id,order_id,connection_id,provider,reference,length_cm,breadth_cm,height_cm,weight_grams)
      VALUES($1,$2,$3,$4,'shiprocket',$5,20,15,10,400)`, [shipmentId, A, orderId, connectionA, `bx${randomUUID().replace(/-/g, '').slice(0, 12)}`]);
    await db.query('INSERT INTO shipment_items(account_id,shipment_id,order_item_id,quantity) VALUES($1,$2,$3,2)', [A, shipmentId, item]);
    expect((await edits.getOrderEditState(owner, orderId)).lines).toEqual([expect.objectContaining({ id: item, quantity: 3, shipped: 2 })]);
    expect(await code(edits.editOrder(owner, orderId, input(0, [[V1, 1]], { refunded_outside: true })))).toBe('below_shipped');
    expect(await code(edits.editOrder(owner, orderId, input(0, [[V2, 1]], { refunded_outside: true })))).toBe('below_shipped');
    expect(await edits.editOrder(owner, orderId, input(0, [[V1, 2]], { refunded_outside: true }))).toMatchObject({ created: true, payment_action: 'refund' });
    expect(await itemsOf(orderId)).toEqual([{ variant: V1, quantity: 2, total: 200000 }]);
  });
});
