import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { createManualOrder, listSellableVariants, ManualOrderError, parseManualOrder } from './manual-orders';
import { transitionOrder } from './order-lifecycle';
import { recordOfflinePayment } from '@/lib/payments/offline';

// Manual orders on PostgreSQL: every price comes from the catalogue (never the body), the stock is held
// with no expiry and released on cancel, a replayed click returns the same order, the order and an audit
// row are written as the member, another workspace's contact or variant is refused, and a viewer cannot
// create one. A recorded payment commits the held stock.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const contactA = randomUUID(), contactB = randomUUID();
const productA = randomUUID(), variantA = randomUUID(), draftProduct = randomUUID(), draftVariant = randomUUID();
const productB = randomUUID(), variantB = randomUUID();
let db: pg.Client;

const agent = { accountId: A, userId: agentA, role: 'agent' as const };
const owner = { accountId: A, userId: ownerA, role: 'owner' as const };
const viewer = { accountId: A, userId: viewerA, role: 'viewer' as const };
const body = (lines: unknown, extra: Record<string, unknown> = {}) =>
  parseManualOrder({ contact_id: contactA, lines, client_request_id: randomUUID(), ...extra });
const level = async (variant = variantA) => (await db.query('SELECT on_hand, reserved FROM inventory_levels WHERE account_id=$1 AND variant_id=$2',
  [A, variant])).rows[0] as { on_hand: number; reserved: number };
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof ManualOrderError ? e.code
  : (e as { code?: string; name?: string }).code ?? (e as { name?: string }).name ?? 'error'));

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('manual orders on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    for (const id of [ownerA, agentA, viewerA, ownerB])
      await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Manual','test-only-hash')", [id, `${id}@example.invalid`]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Manual A',$2),($3,'Manual B',$4)", [A, ownerA, B, ownerB]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [A, B]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')",
      [A, ownerA, agentA, viewerA, B, ownerB]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Asha','14155550101'),($4,$5,$6,'Other','14155550102')",
      [contactA, A, ownerA, contactB, B, ownerB]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps)
      VALUES($1,'INR',true,1800),($2,'INR',true,1800)`, [A, B]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES
      ($1,$2,'Face oil','published',now()),($3,$2,'Draft oil','draft',NULL),($4,$5,'Other shop oil','published',now())`,
    [productA, A, draftProduct, productB, B]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES
      ($1,$2,$3,'OIL-15',129900),($4,$2,$5,'DRAFT-1',1000),($6,$7,$8,'B-OIL',100)`,
    [variantA, A, productA, draftVariant, draftProduct, variantB, B, productB]);
    await db.query('INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,5),($3,$4,5)', [A, variantA, B, variantB]);
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

  it('prices every line from the catalogue, holds the stock and audits the member', async () => {
    const input = body([{ variant_id: variantA, qty: 2 }]);
    const { orderId, created } = await createManualOrder(agent, input);
    expect(created).toBe(true);
    const order = (await db.query(`SELECT source, status, payment_method, priced_at IS NOT NULL AS priced, total_minor::int AS total,
      subtotal_minor::int AS subtotal, contact_id FROM orders WHERE id=$1`, [orderId])).rows[0];
    expect(order).toMatchObject({ source: 'manual', status: 'confirmed', payment_method: 'online', priced: true, total: 259800, subtotal: 259800, contact_id: contactA });
    const items = (await db.query('SELECT unit_price_minor::int AS unit, quantity, sku FROM order_items WHERE order_id=$1', [orderId])).rows;
    expect(items).toEqual([{ unit: 129900, quantity: 2, sku: 'OIL-15' }]);
    expect(await level()).toEqual({ on_hand: 5, reserved: 2 });
    const audit = (await db.query("SELECT user_id::text AS user_id, metadata FROM audit_logs WHERE account_id=$1 AND action='order.manual_created' AND resource_id=$2",
      [A, orderId])).rows[0];
    expect(audit.user_id).toBe(agentA);
    expect(JSON.stringify(audit.metadata)).not.toContain('Asha');
    // A replay of the same click returns the same order and holds nothing more.
    expect(await createManualOrder(agent, input)).toEqual({ orderId, created: false });
    expect(await level()).toEqual({ on_hand: 5, reserved: 2 });
    // Cancelling releases the hold.
    await transitionOrder(agent, orderId, { from: 'confirmed', to: 'cancelled' });
    expect(await level()).toEqual({ on_hand: 5, reserved: 0 });
  });

  it('refuses a price, total or name in the body', () => {
    for (const extra of [{ total_minor: 1 }, { price_minor: 1 }]) expect(() => body([{ variant_id: variantA, qty: 1 }], extra)).toThrow(ManualOrderError);
    expect(() => body([{ variant_id: variantA, qty: 1, unit_price_minor: 1 }])).toThrow(ManualOrderError);
    expect(() => body([{ variant_id: variantA, qty: 1, name: 'Free' }])).toThrow(ManualOrderError);
  });

  it('refuses more than the free stock, a draft product, and another workspace\'s contact or variant', async () => {
    expect(await code(createManualOrder(agent, body([{ variant_id: variantA, qty: 6 }])))).toBe('out_of_stock');
    expect(await code(createManualOrder(agent, body([{ variant_id: draftVariant, qty: 1 }])))).toBe('variant_unavailable');
    expect(await code(createManualOrder(agent, body([{ variant_id: variantB, qty: 1 }])))).toBe('variant_unavailable');
    expect(await code(createManualOrder(agent, body([{ variant_id: variantA, qty: 1 }], { contact_id: contactB })))).toBe('contact_not_found');
    expect((await db.query('SELECT count(*)::int AS n FROM orders WHERE account_id=$1 AND contact_id=$2', [A, contactB])).rows[0].n).toBe(0);
    expect(await level(variantB)).toBeUndefined();
    expect((await db.query('SELECT reserved FROM inventory_levels WHERE account_id=$1 AND variant_id=$2', [B, variantB])).rows[0].reserved).toBe(0);
  });

  it('a viewer cannot create a manual order', async () => {
    expect(await code(createManualOrder(viewer, body([{ variant_id: variantA, qty: 1 }])))).toBe('ForbiddenError');
  });

  it('lists only published, priced variants of the caller\'s own workspace', async () => {
    const { variants, currency } = await listSellableVariants(agent, null);
    expect(currency).toBe('INR');
    expect(variants.map((v) => v.id)).toEqual([variantA]);
    expect((await listSellableVariants(agent, 'OIL-15')).variants).toHaveLength(1);
    expect((await listSellableVariants(agent, 'nothing like it')).variants).toHaveLength(0);
  });

  it('a recorded payment commits the held stock and marks the order paid', async () => {
    const { orderId } = await createManualOrder(owner, body([{ variant_id: variantA, qty: 1 }]));
    expect(await level()).toEqual({ on_hand: 5, reserved: 1 });
    await recordOfflinePayment(owner, orderId, { amount: '1299.00', method: 'cash', reference: null, clientRequestId: randomUUID() });
    expect((await db.query('SELECT status FROM orders WHERE id=$1', [orderId])).rows[0].status).toBe('paid');
    expect(await level()).toEqual({ on_hand: 4, reserved: 0 });
  });
});
