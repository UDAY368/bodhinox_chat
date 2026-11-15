import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import {
  createAutoDiscount, deleteAutoDiscount, listAutoDiscounts, loadAutoDiscountsTx, parseAutoDiscount, updateAutoDiscount,
} from './auto-discount-rules';
import { placeOrder } from './checkout';
import { getOrder } from './orders';
import { issueSessionTx, loadOrderView, loadSession, quoteSessionTx, setAddressTx, setPaymentMethodTx, updateCartTx } from './storefront';

// Store plan Phase 3 automatic discounts on PostgreSQL: the quote and the
// placed order agree and the order keeps what was applied; another workspace's
// rules never apply and cannot be read or changed; agents and the worker
// cannot write rules; edits are version-checked; the 20-rule cap holds.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const account = randomUUID(), other = randomUUID(), owner = randomUUID();
const product = randomUUID(), variant = randomUUID(), cheapProduct = randomUUID(), cheapVariant = randomUUID(), otherProduct = randomUUID();
const contacts = Array.from({ length: 4 }, () => randomUUID());
let db: pg.Client;

const admin = { accountId: account, userId: owner, role: 'admin' as const };
const agent = { ...admin, role: 'agent' as const };
const otherAdmin = { accountId: other, userId: owner, role: 'admin' as const };
const worker = <T,>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: account, role: 'owner' }, fn, getWorkerPrisma());
const ADDRESS = { name: 'Buyer', phone: '+919876543210', line1: '1 MG Road', city: 'Bengaluru', postal_code: '560001', country: 'IN' };
const input = (body: Record<string, unknown>) => parseAutoDiscount({ min_subtotal_minor: 0, active: true, ...body });

/** A shop session with 2 × 20000 and 1 × 5000 (subtotal 45000), an address, and the payment method. */
async function session(contactId: string, method: 'online' | 'cod') {
  const sessionId = randomUUID();
  await worker((tx) => issueSessionTx(tx, account, {
    sessionId, contactId, conversationId: null, whatsappConfigId: null, purpose: 'shop', orderId: null, ttlHours: 24, createdBy: null,
  }));
  await worker((tx) => updateCartTx(tx, account, sessionId, {
    expectedVersion: 1, lines: [{ variantId: variant, qty: 2 }, { variantId: cheapVariant, qty: 1 }],
  }));
  await worker((tx) => setAddressTx(tx, account, sessionId, { expectedVersion: 2, address: ADDRESS }));
  let version = 3;
  if (method === 'cod') {
    await worker((tx) => setPaymentMethodTx(tx, account, sessionId, { expectedVersion: version, paymentMethod: 'cod' }));
    version += 1;
  }
  const result = await worker(async (tx) => (await quoteSessionTx(tx, account, (await loadSession(tx, account, sessionId))!)).result);
  if (!result.ok) throw new Error(`quote refused: ${result.code}`);
  return { sessionId, version, quote: result.quote };
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('store phase 3 automatic discounts on PostgreSQL', { timeout: 120_000 }, () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    const q = (sql: string, values: unknown[]) => db.query(sql, values);
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid,$2,'P3 discounts','test-only-hash')", [owner, `${owner}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P3 discounts',$3),($2,'P3 other',$3)", [account, other, owner]);
    await q("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [account, other]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$3,'owner'),($2,$3,'owner')", [account, other, owner]);
    await q(`INSERT INTO contacts(id,account_id,user_id,name,phone)
      SELECT c, $2, $3, 'Buyer', '1415777' || lpad(n::text, 4, '0') FROM unnest($1::uuid[]) WITH ORDINALITY AS t(c, n)`, [contacts, account, owner]);
    await q(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,cod_enabled,cod_fee_minor)
      VALUES($1,'INR',false,500,true,true,3000),($2,'INR',false,500,true,false,0)`, [account, other]);
    await q(`INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc) VALUES($1,'razorpay','test','rzp_test_P3AD','enc')`, [account]);
    await q(`INSERT INTO shipping_rates(account_id,name,country,fee_minor,tax_rate_bps) VALUES($1,'India','IN',6000,0)`, [account]);
    await q(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at)
      VALUES($1,$3,'Triphala','published',now()),($2,$3,'Soap','published',now()),($4,$5,'Other shop item','published',now())`,
    [product, cheapProduct, account, otherProduct, other]);
    await q(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$3,$2,'TRI-100',20000),($4,$3,$5,'SOAP-1',5000)`,
      [variant, product, account, cheapVariant, cheapProduct]);
    await q(`INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,100),($1,$3,100)`, [account, variant, cheapVariant]);
    // The other workspace has a rule that would take 90% off, and free shipping on everything.
    await q(`INSERT INTO shop_auto_discounts(account_id,name,kind,percent_bps) VALUES($1,'Other 90','percent_off_over',9000)`, [other]);
    await q(`INSERT INTO shop_auto_discounts(account_id,name,kind) VALUES($1,'Other free ship','free_shipping_over')`, [other]);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM auth_users WHERE id=$1', [owner]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('prices with no rules of its own: another workspace\'s rules never apply', async () => {
    const { quote } = await session(contacts[0], 'online');
    expect(quote).toMatchObject({ subtotalMinor: 45_000, discountMinor: 0, autoDiscountMinor: 0, autoDiscounts: [], shippingMinor: 6_000 });
    expect(await worker((tx) => loadAutoDiscountsTx(tx, account))).toEqual([]);
  });

  it('lets an admin create rules, audits field names only, and refuses bad shapes', async () => {
    ids.percent = (await createAutoDiscount(admin, input({ name: '10% off over 400', kind: 'percent_off_over', percent_bps: 1000, min_subtotal_minor: 40_000 }))).id;
    ids.small = (await createAutoDiscount(admin, input({ name: 'Rs 10 off', kind: 'amount_off_over', amount_minor: 1000 }))).id;
    ids.prepaid = (await createAutoDiscount(admin, input({ name: 'Pay online', kind: 'prepaid', percent_bps: 500 }))).id;
    // Between the subtotal after prepaid (38475) and before it (40500): paying online must still get it.
    ids.free = (await createAutoDiscount(admin, input({ name: 'Free delivery', kind: 'free_shipping_over', min_subtotal_minor: 39_000 }))).id;
    ids.bxgy = (await createAutoDiscount(admin, input({ name: 'Buy 2 get 1', kind: 'buy_x_get_y', buy_qty: 2, get_qty: 1, product_ids: [product] }))).id;
    expect((await listAutoDiscounts(admin)).map((r) => r.name).sort()).toEqual(['10% off over 400', 'Buy 2 get 1', 'Free delivery', 'Pay online', 'Rs 10 off']);

    const audit = await db.query(`SELECT action, metadata FROM audit_logs WHERE account_id=$1 AND resource_id=$2`, [account, ids.percent]);
    expect(audit.rows).toEqual([{ action: 'commerce.auto_discount_created', metadata: { kind: 'percent_off_over' } }]);

    // A product of another workspace cannot be named; each kind takes only its own fields.
    await expect(createAutoDiscount(admin, input({ name: 'Bad', kind: 'buy_x_get_y', buy_qty: 1, get_qty: 1, product_ids: [otherProduct] })))
      .rejects.toMatchObject({ code: 'invalid' });
    expect(() => input({ name: 'Bad', kind: 'amount_off_over', amount_minor: 100, percent_bps: 100 })).toThrow();
    expect(() => input({ name: 'Bad', kind: 'prepaid', amount_minor: 100, percent_bps: 100 })).toThrow();
    expect(() => input({ name: 'Bad', kind: 'free_shipping_over', buy_qty: 1 })).toThrow();
    expect(() => input({ name: '<b>Bad</b>', kind: 'free_shipping_over' })).toThrow();
    // The table refuses the same shapes even if code let them through.
    await expect(db.query(`INSERT INTO shop_auto_discounts(account_id,name,kind,amount_minor,percent_bps) VALUES($1,'x','amount_off_over',100,100)`, [account]))
      .rejects.toThrow(/shop_auto_discounts_kind_fields/);
    await expect(db.query(`INSERT INTO shop_auto_discounts(account_id,name,kind) VALUES($1,'x','prepaid')`, [account]))
      .rejects.toThrow(/shop_auto_discounts_kind_fields/);
  });

  it('gives the same numbers in the quote and the placed order, and stores what was applied', async () => {
    const s = await session(contacts[1], 'online');
    // Subtotal 45000. Best of: 10% = 4500, Rs 10 = 1000, buy 2 get 1 on Triphala only (2 units, no full set) = 0.
    // Prepaid 5% of 40500 = 2025. Free delivery reads 40500 (before prepaid) >= 39000: fee 6000 waived.
    expect(s.quote.autoDiscounts).toEqual([
      { id: ids.percent, name: '10% off over 400', kind: 'percent_off_over', savingMinor: 4_500 },
      { id: ids.prepaid, name: 'Pay online', kind: 'prepaid', savingMinor: 2_025 },
      { id: ids.free, name: 'Free delivery', kind: 'free_shipping_over', savingMinor: 6_000 },
    ]);
    expect(s.quote).toMatchObject({ autoDiscountMinor: 6_525, discountMinor: 6_525, shippingMinor: 0, prepaidSavingMinor: 0 });

    const placed = await placeOrder(account, s.sessionId, { expectedVersion: s.version, expectedTotalMinor: s.quote.totalMinor, clientRequestId: randomUUID() });
    const order = (await db.query(`SELECT subtotal_minor::int AS subtotal, discount_minor::int AS discount, auto_discount_minor::int AS auto,
      shipping_minor::int AS shipping, tax_minor::int AS tax, total_minor::int AS total, discount_details FROM orders WHERE id=$1`, [placed.orderId])).rows[0];
    expect(order).toEqual({
      subtotal: 45_000, discount: 6_525, auto: 6_525, shipping: 0, tax: s.quote.taxMinor, total: s.quote.totalMinor,
      // Names and savings only: no rule ids or settings.
      discount_details: [
        { name: '10% off over 400', kind: 'percent_off_over', saving_minor: 4_500 },
        { name: 'Pay online', kind: 'prepaid', saving_minor: 2_025 },
        { name: 'Free delivery', kind: 'free_shipping_over', saving_minor: 6_000 },
      ],
    });
    // The lines carry the discount (they sum to the order discount) and tax is on the amount after it.
    const items = (await db.query(`SELECT quantity * unit_price_minor::int AS gross, discount_minor::int AS discount, tax_minor::int AS tax,
      tax_rate_bps AS bps FROM order_items WHERE order_id=$1 ORDER BY unit_price_minor DESC`, [placed.orderId])).rows;
    expect(items.reduce((sum, i) => sum + i.discount, 0)).toBe(6_525);
    for (const i of items) expect(i.tax).toBe(Math.round((i.gross - i.discount) * i.bps / 10_000));
    expect(order.total).toBe(45_000 - 6_525 + items.reduce((sum, i) => sum + i.tax, 0));

    // The customer's order summary and the admin order view both show the names and savings.
    const view = await worker((tx) => loadOrderView(tx, account, placed.orderId));
    expect(view).toMatchObject({
      discountMinor: 6_525, autoDiscountMinor: 6_525,
      autoDiscounts: [
        { name: '10% off over 400', kind: 'percent_off_over', savingMinor: 4_500 },
        { name: 'Pay online', kind: 'prepaid', savingMinor: 2_025 },
        { name: 'Free delivery', kind: 'free_shipping_over', savingMinor: 6_000 },
      ],
    });
    const detail = await getOrder(agent, placed.orderId);
    expect(detail).toMatchObject({ discount_minor: 6_525, auto_discount_minor: 6_525 });
    expect(detail.discount_details.map((d) => [d.name, d.saving_minor])).toEqual([['10% off over 400', 4_500], ['Pay online', 2_025], ['Free delivery', 6_000]]);
    // Another workspace cannot open the order.
    await expect(getOrder(otherAdmin, placed.orderId)).rejects.toMatchObject({ code: 'not_found' });

    // Once priced, the stored discount cannot be rewritten.
    await expect(db.query('UPDATE orders SET auto_discount_minor=0 WHERE id=$1', [placed.orderId])).rejects.toThrow(/order_priced_frozen/);
    await expect(db.query(`UPDATE orders SET discount_details='[]'::jsonb WHERE id=$1`, [placed.orderId])).rejects.toThrow(/order_priced_frozen/);
  });

  it('leaves the prepaid discount off a cash on delivery order and offers it', async () => {
    const s = await session(contacts[2], 'cod');
    expect(s.quote.autoDiscounts.map((d) => d.kind)).toEqual(['percent_off_over', 'free_shipping_over']);
    expect(s.quote).toMatchObject({ autoDiscountMinor: 4_500, discountMinor: 4_500, prepaidSavingMinor: 2_025, codFeeMinor: 3_000, shippingMinor: 0 });
    const placed = await placeOrder(account, s.sessionId, { expectedVersion: s.version, expectedTotalMinor: s.quote.totalMinor, clientRequestId: randomUUID() });
    const order = (await db.query(`SELECT discount_minor::int AS discount, auto_discount_minor::int AS auto, total_minor::int AS total, payment_method
      FROM orders WHERE id=$1`, [placed.orderId])).rows[0];
    expect(order).toEqual({ discount: 4_500, auto: 4_500, total: s.quote.totalMinor, payment_method: 'cod' });
  });

  it('refuses a place when a rule changed after the quote was shown', async () => {
    const s = await session(contacts[3], 'online');
    const before = (await listAutoDiscounts(admin)).find((r) => r.id === ids.prepaid)!;
    await updateAutoDiscount(admin, ids.prepaid, before.version, input({ name: 'Pay online', kind: 'prepaid', percent_bps: 500, active: false }));
    await expect(placeOrder(account, s.sessionId, { expectedVersion: s.version, expectedTotalMinor: s.quote.totalMinor, clientRequestId: randomUUID() }))
      .rejects.toMatchObject({ code: 'quote_changed' });
    expect((await db.query('SELECT count(*)::int AS n FROM orders WHERE account_id=$1 AND contact_id=$2', [account, contacts[3]])).rows[0].n).toBe(0);
  });

  it('checks the version on edit', async () => {
    const rule = (await listAutoDiscounts(admin)).find((r) => r.id === ids.small)!;
    const body = input({ name: 'Rs 20 off', kind: 'amount_off_over', amount_minor: 2000 });
    const saved = await updateAutoDiscount(admin, ids.small, rule.version, body);
    expect(saved).toMatchObject({ name: 'Rs 20 off', amount_minor: 2000, version: rule.version + 1 });
    await expect(updateAutoDiscount(admin, ids.small, rule.version, body)).rejects.toMatchObject({ code: 'conflict' });
    await expect(updateAutoDiscount(admin, randomUUID(), 1, body)).rejects.toMatchObject({ code: 'not_found' });
    await expect(updateAutoDiscount(admin, ids.small, undefined, body)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('keeps another workspace out: it cannot see, change or delete these rules', async () => {
    expect((await listAutoDiscounts(otherAdmin)).map((r) => r.name).sort()).toEqual(['Other 90', 'Other free ship']);
    const body = input({ name: 'Taken over', kind: 'percent_off_over', percent_bps: 9900 });
    await expect(updateAutoDiscount(otherAdmin, ids.percent, 1, body)).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteAutoDiscount(otherAdmin, ids.percent)).rejects.toMatchObject({ code: 'not_found' });
    const mine = (await listAutoDiscounts(admin)).find((r) => r.id === ids.percent)!;
    expect(mine).toMatchObject({ name: '10% off over 400', percent_bps: 1000, version: 1 });
  });

  it('lets an agent read but not write, and the worker only read', async () => {
    expect((await listAutoDiscounts(agent)).length).toBe(5);
    const body = input({ name: 'Agent rule', kind: 'percent_off_over', percent_bps: 5000 });
    await expect(createAutoDiscount(agent, body)).rejects.toThrow();
    await expect(updateAutoDiscount(agent, ids.percent, 1, body)).rejects.toThrow();
    await expect(deleteAutoDiscount(agent, ids.percent)).rejects.toThrow();
    await expect(worker((tx) => tx.$executeRaw`INSERT INTO shop_auto_discounts(account_id,name,kind,percent_bps)
      VALUES(${account}::uuid,'Worker rule','percent_off_over',5000)`)).rejects.toThrow();
    await expect(worker((tx) => tx.$executeRaw`UPDATE shop_auto_discounts SET percent_bps=9000 WHERE id=${ids.percent}::uuid`)).rejects.toThrow();
    const rows = (await db.query('SELECT name, percent_bps FROM shop_auto_discounts WHERE account_id=$1 ORDER BY name', [account])).rows;
    expect(rows.map((r) => r.name)).toEqual(['10% off over 400', 'Buy 2 get 1', 'Free delivery', 'Pay online', 'Rs 20 off']);
    expect(rows[0].percent_bps).toBe(1000);
  });

  it('deletes with an audit row and holds the 20-rule cap', async () => {
    await deleteAutoDiscount(admin, ids.bxgy);
    await expect(deleteAutoDiscount(admin, ids.bxgy)).rejects.toMatchObject({ code: 'not_found' });
    const audit = await db.query(`SELECT action, metadata FROM audit_logs WHERE account_id=$1 AND resource_id=$2 ORDER BY created_at`, [account, ids.bxgy]);
    expect(audit.rows.map((r) => r.action)).toEqual(['commerce.auto_discount_created', 'commerce.auto_discount_deleted']);
    expect(audit.rows[1].metadata).toEqual({});

    const have = (await listAutoDiscounts(admin)).length;
    for (let i = have; i < 20; i++) await createAutoDiscount(admin, input({ name: `Filler ${i}`, kind: 'free_shipping_over', active: false }));
    await expect(createAutoDiscount(admin, input({ name: 'One too many', kind: 'free_shipping_over' }))).rejects.toMatchObject({ code: 'auto_discount_limit' });
    expect((await db.query('SELECT count(*)::int AS n FROM shop_auto_discounts WHERE account_id=$1', [account])).rows[0].n).toBe(20);
  });
});
