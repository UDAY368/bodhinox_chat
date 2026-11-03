import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { recordWhatsAppOrder } from './orders';

// Phase 8 schema guards on PostgreSQL (design E4, E5, E8, E10, E14; test 6):
// worker-only order statuses, paid-before-dispatch for priced orders, frozen
// price snapshots, the status history trigger, composite tenant FKs, RLS on
// every new table, append-only ledgers and the payment link key stamp.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, agentA, viewerA, ownerB];
const asAgent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asAdmin: TenantContext = { accountId: accountA, userId: ownerA, role: 'admin' };
const asViewer: TenantContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asSystem: TenantContext = { accountId: accountA, role: 'owner' };
const contactA = randomUUID(), contactB = randomUUID();
const productA = randomUUID(), variantA = randomUUID(), productB = randomUUID(), variantB = randomUUID();
const legacyOrder = randomUUID(), pricedOrder = randomUUID(), paidOrder = randomUUID();
const pricedItem = randomUUID();
let db: pg.Client;

const NEW_TABLES = ['commerce_settings', 'shop_categories', 'shop_products', 'shop_product_images', 'shop_variants',
  'inventory_levels', 'inventory_movements', 'shipping_rates', 'coupons', 'coupon_redemptions', 'storefront_sessions',
  'stock_reservations', 'customer_payments', 'customer_refunds', 'payment_exceptions', 'order_events', 'order_returns',
  'commerce_document_sequences', 'commerce_documents', 'order_messages'];

const app = <T,>(ctx: TenantContext, fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctx, fn);
const worker = <T,>(ctx: TenantContext, fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctx, fn, getWorkerPrisma());
const setStatus = (id: string, status: string) => (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) =>
  tx.$executeRaw`UPDATE orders SET status=${status} WHERE account_id=${accountA}::uuid AND id=${id}::uuid`;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('phase 8 order and payment guards on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P8 guard', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P8 A',$2),($3,'P8 B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [accountA, accountB]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')`,
      [accountA, ownerA, agentA, viewerA, accountB, ownerB]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'A','14155550801'),($4,$5,$6,'B','14155550802')",
      [contactA, accountA, ownerA, contactB, accountB, ownerB]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,default_tax_rate_bps) VALUES($1,'INR',1800)`, [accountA]);
    await db.query(`INSERT INTO shop_products(id,account_id,name) VALUES($1,$2,'Ashwagandha'),($3,$4,'Other')`, [productA, accountA, productB, accountB]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'ASH-60',49900),($4,$5,$6,'OTH-1',100)`,
      [variantA, accountA, productA, variantB, accountB, productB]);
    await db.query(`INSERT INTO inventory_levels(account_id,variant_id,on_hand,reserved) VALUES($1,$2,5,1)`, [accountA, variantA]);
    await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,total_minor,status)
      VALUES($1,$2,'manual',$3,'INR',1000,1000,'confirmed')`, [legacyOrder, accountA, contactA]);
    // Priced: 2 x 499.00 inclusive of tax, 50.00 shipping, 100.00 coupon: 998 - 100 + 50 = 948.
    await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,discount_minor,shipping_minor,tax_minor,
        tax_inclusive,total_minor,status,priced_at)
      VALUES($1,$2,'storefront',$3,'INR',99800,10000,5000,13700,true,94800,'awaiting_payment',now()),
            ($4,$2,'storefront',$3,'INR',99800,10000,5000,13700,true,94800,'paid',now())`, [pricedOrder, accountA, contactA, paidOrder]);
    await db.query(`INSERT INTO order_items(id,account_id,order_id,variant_id,sku,quantity,unit_price_minor,currency,line_total_minor)
      VALUES($1,$2,$3,$4,'ASH-60',2,49900,'INR',89800)`, [pricedItem, accountA, pricedOrder, variantA]);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('never lets a browser session set or leave a worker-only status', async () => {
    for (const status of ['paid', 'payment_review', 'expired'])
      await expect(app(asAgent, setStatus(pricedOrder, status))).rejects.toThrow(/order_status_forbidden/);
    await expect(app(asAdmin, setStatus(legacyOrder, 'paid'))).rejects.toThrow(/order_status_forbidden/);
    // The worker (after a verified payment) may.
    await worker(asSystem, async (tx) => {
      await setStatus(legacyOrder, 'awaiting_payment')(tx);
      await setStatus(legacyOrder, 'paid')(tx);
      // Roll back: keep the legacy order for the next test.
      throw new Error('rollback');
    }).catch((e: Error) => { if (e.message !== 'rollback') throw e; });
  });

  it('dispatches a priced order only after payment; a legacy order keeps confirmed -> fulfilled', async () => {
    await expect(app(asAgent, setStatus(pricedOrder, 'dispatched'))).rejects.toThrow(/order_not_paid/);
    await expect(worker(asSystem, setStatus(pricedOrder, 'fulfilled'))).rejects.toThrow(/order_not_paid/);
    await app(asAgent, setStatus(paidOrder, 'dispatched'));
    await app(asAgent, setStatus(legacyOrder, 'fulfilled'));
    const rows = (await db.query(`SELECT id,status,dispatched_at IS NOT NULL AS d,delivered_at IS NOT NULL AS f,fulfilment_recorded_by
      FROM orders WHERE id=ANY($1::uuid[])`, [[paidOrder, legacyOrder]])).rows;
    expect(rows.find((r) => r.id === paidOrder)).toMatchObject({ status: 'dispatched', d: true, fulfilment_recorded_by: agentA });
    expect(rows.find((r) => r.id === legacyOrder)).toMatchObject({ status: 'fulfilled', f: true, fulfilment_recorded_by: agentA });
  });

  it('records every status change as staff or system', async () => {
    await worker(asSystem, setStatus(pricedOrder, 'expired'));
    const events = (await db.query(`SELECT order_id,kind,from_status,to_status,actor,actor_user_id FROM order_events
      WHERE account_id=$1 ORDER BY created_at`, [accountA])).rows;
    expect(events).toEqual(expect.arrayContaining([
      { order_id: paidOrder, kind: 'status_changed', from_status: 'paid', to_status: 'dispatched', actor: 'staff', actor_user_id: agentA },
      { order_id: legacyOrder, kind: 'status_changed', from_status: 'confirmed', to_status: 'fulfilled', actor: 'staff', actor_user_id: agentA },
      { order_id: pricedOrder, kind: 'status_changed', from_status: 'awaiting_payment', to_status: 'expired', actor: 'system', actor_user_id: null },
    ]));
    // The failed and rolled-back attempts left no history.
    expect(events.filter((e) => e.to_status === 'paid')).toEqual([]);
  });

  it('freezes a priced order and its lines for every role', async () => {
    await expect(worker(asSystem, (tx) => tx.$executeRaw`UPDATE orders SET total_minor=1 WHERE id=${pricedOrder}::uuid`))
      .rejects.toThrow(/order_priced_frozen/);
    await expect(worker(asSystem, (tx) => tx.$executeRaw`UPDATE orders SET shipping_address='{"line1":"x"}' WHERE id=${pricedOrder}::uuid`))
      .rejects.toThrow(/order_priced_frozen/);
    await expect(worker(asSystem, (tx) => tx.$executeRaw`UPDATE order_items SET unit_price_minor=1 WHERE id=${pricedItem}::uuid`))
      .rejects.toThrow(/order_priced_frozen/);
    // A priced total must equal its parts.
    await expect(db.query(`INSERT INTO orders(account_id,source,currency,subtotal_minor,tax_inclusive,total_minor,priced_at)
      VALUES($1,'storefront','INR',1000,false,1000,now())`, [accountA]).then(() => db.query('SELECT 1'))).resolves.toBeTruthy();
    await expect(db.query(`INSERT INTO orders(account_id,source,currency,subtotal_minor,tax_minor,tax_inclusive,total_minor,priced_at)
      VALUES($1,'storefront','INR',1000,180,false,1000,now())`, [accountA])).rejects.toThrow(/orders_priced_total_check/);
    // Non-price columns still change (the worker records payment progress).
    await worker(asSystem, (tx) => tx.$executeRaw`UPDATE orders SET amount_paid_minor=0, checkout_attempt=1 WHERE id=${pricedOrder}::uuid`);
  });

  it('rejects another workspace\'s rows in composite foreign keys', async () => {
    await expect(worker(asSystem, (tx) => tx.$executeRaw`INSERT INTO stock_reservations(account_id,order_id,variant_id,quantity)
      VALUES(${accountA}::uuid,${pricedOrder}::uuid,${variantB}::uuid,1)`)).rejects.toThrow();
    await expect(worker(asSystem, (tx) => tx.$executeRaw`INSERT INTO storefront_sessions(account_id,token_hash,contact_id,purpose,expires_at)
      VALUES(${accountA}::uuid,${'a'.repeat(64)},${contactB}::uuid,'shop',now() + interval '1 hour')`)).rejects.toThrow();
    await expect(app(asAdmin, (tx) => tx.$executeRaw`INSERT INTO shop_variants(account_id,product_id,sku)
      VALUES(${accountA}::uuid,${productB}::uuid,'X-1')`)).rejects.toThrow();
  });

  it('keeps stock between zero and on hand', async () => {
    await expect(worker(asSystem, (tx) => tx.$executeRaw`UPDATE inventory_levels SET reserved=6 WHERE variant_id=${variantA}::uuid`))
      .rejects.toThrow(/check/i);
    await expect(worker(asSystem, (tx) => tx.$executeRaw`UPDATE inventory_levels SET on_hand=0 WHERE variant_id=${variantA}::uuid`))
      .rejects.toThrow(/check/i);
    // The conditional reserve: nothing is reserved past what is available.
    const reserved = await worker(asSystem, (tx) => tx.$executeRaw`UPDATE inventory_levels SET reserved=reserved+5
      WHERE account_id=${accountA}::uuid AND variant_id=${variantA}::uuid AND on_hand-reserved >= 5`);
    expect(reserved).toBe(0);
  });

  it('lets viewers read none of the new tables, and agents only their workspace', async () => {
    await worker(asSystem, (tx) => tx.$executeRaw`INSERT INTO inventory_movements(account_id,variant_id,kind,quantity,on_hand_after,reserved_after)
      VALUES(${accountA}::uuid,${variantA}::uuid,'receipt',5,5,1)`);
    for (const table of NEW_TABLES) {
      const [viewer] = await app(asViewer, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`));
      expect([table, viewer.n]).toEqual([table, 0]);
    }
    const [agent] = await app(asAgent, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shop_variants`);
    expect(agent.n).toBe(1);
    const [movements] = await app(asAgent, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM inventory_movements`);
    expect(movements.n).toBe(1);
  });

  it('keeps ledgers append-only and worker-written', async () => {
    await expect(app(asAdmin, (tx) => tx.$executeRaw`INSERT INTO inventory_movements(account_id,variant_id,kind,quantity,on_hand_after,reserved_after)
      VALUES(${accountA}::uuid,${variantA}::uuid,'receipt',100,100,0)`)).rejects.toThrow();
    await expect(app(asAdmin, (tx) => tx.$executeRaw`UPDATE inventory_levels SET on_hand=100`)).rejects.toThrow();
    await expect(worker(asSystem, (tx) => tx.$executeRaw`UPDATE inventory_movements SET quantity=1`)).rejects.toThrow();
    await expect(worker(asSystem, (tx) => tx.$executeRaw`DELETE FROM order_events`)).rejects.toThrow();
    // A browser session cannot forge history: only its own staff status_changed rows pass.
    await expect(app(asAgent, (tx) => tx.$executeRaw`INSERT INTO order_events(account_id,order_id,kind,actor,actor_user_id)
      VALUES(${accountA}::uuid,${pricedOrder}::uuid,'payment_captured','system',NULL)`)).rejects.toThrow();
    await expect(app(asAgent, (tx) => tx.$executeRaw`INSERT INTO order_events(account_id,order_id,kind,actor,actor_user_id)
      VALUES(${accountA}::uuid,${pricedOrder}::uuid,'status_changed','staff',${ownerA}::uuid)`)).rejects.toThrow();
    for (const sql of [
      `INSERT INTO customer_payments(account_id,source,amount_minor,currency,status) VALUES('${accountA}','offline',100,'INR','captured')`,
      `INSERT INTO customer_refunds(account_id,payment_id,source,amount_minor,currency,reason_code,status) VALUES('${accountA}','${randomUUID()}','bodhinox',1,'INR','other','requested')`,
      `INSERT INTO storefront_sessions(account_id,token_hash,contact_id,purpose,expires_at) VALUES('${accountA}','${'b'.repeat(64)}','${contactA}','shop',now())`,
      `UPDATE orders SET amount_paid_minor=94800 WHERE id='${pricedOrder}'`,
      `UPDATE appointments SET payment_status='paid'`,
    ]) await expect(app(asAdmin, (tx) => tx.$executeRawUnsafe(sql))).rejects.toThrow();
  });

  it('stamps the connected key on a payment link, whatever the app supplies', async () => {
    await db.query(`INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc) VALUES($1,'razorpay','test','rzp_test_GUARD','enc')`, [accountA]);
    const [row] = await app(asAgent, (tx) => tx.$queryRaw<{ provider_key_id: string | null }[]>`
      INSERT INTO payment_links(account_id,provider,reference_id,amount_minor,currency,provider_key_id)
      VALUES(${accountA}::uuid,'razorpay',${`co_${randomUUID().replace(/-/g, '').slice(0, 24)}`},100,'INR','rzp_live_FORGED')
      RETURNING provider_key_id`);
    expect(row.provider_key_id).toBe('rzp_test_GUARD');
  });

  it('accepts a restriction row for each permission and resolves only live storefront tokens', async () => {
    for (const permission of PERMISSIONS.filter((p) => p.startsWith('commerce.')))
      await app(asAdmin, (tx) => tx.$executeRaw`INSERT INTO role_permission_restrictions(account_id,role,permission)
        VALUES(${accountA}::uuid,'agent',${permission})`);
    const live = randomUUID(), revoked = randomUUID();
    await db.query(`INSERT INTO storefront_sessions(id,account_id,token_hash,contact_id,purpose,expires_at,revoked_at) VALUES
      ($1,$2,$3,$4,'shop',now() + interval '1 hour',NULL),($5,$2,$6,$4,'shop',now() + interval '1 hour',now())`,
      [live, accountA, 'c'.repeat(64), contactA, revoked, 'd'.repeat(64)]);
    const resolve = (hash: string) => getWorkerPrisma().$queryRaw<{ account_id: string; session_id: string }[]>`
      SELECT * FROM resolve_storefront_token(${hash})`;
    expect(await resolve('c'.repeat(64))).toEqual([{ account_id: accountA, session_id: live }]);
    expect(await resolve('d'.repeat(64))).toEqual([]);
    await expect(getPrisma().$queryRaw`SELECT * FROM resolve_storefront_token(${'c'.repeat(64)})`).rejects.toThrow();
    const plans = (await db.query(`SELECT features->>'storefront' AS f FROM plans WHERE id IN ('free','basic','pro','enterprise')`)).rows;
    expect(plans.map((p) => p.f)).toEqual(['true', 'true', 'true', 'true']);
  });

  it('queues the checkout preparation with a WhatsApp cart only while store checkout is on', async () => {
    const conversation = randomUUID();
    await db.query('INSERT INTO conversations(id,account_id,user_id,contact_id) VALUES($1,$2,$3,$4)', [conversation, accountA, ownerA, contactA]);
    const cart = { catalog_id: null, currency: 'INR', subtotal_minor: 49900, note: null,
      items: [{ retailer_id: 'ASH-60', name: null, quantity: 1, unit_price_minor: 49900 }] };
    const place = (orderId: string, wamid: string) => worker(asSystem, (tx) => recordWhatsAppOrder(tx, {
      accountId: accountA, orderId, metaMessageId: wamid, contactId: contactA, conversationId: conversation, whatsappConfigId: null, order: cart }));
    const off = randomUUID(), on = randomUUID();
    expect(await place(off, `wamid.p8.off.${off}`)).toBe(true);
    await db.query('UPDATE commerce_settings SET checkout_enabled=true WHERE account_id=$1', [accountA]);
    expect(await place(on, `wamid.p8.on.${on}`)).toBe(true);
    // A redelivered webhook stores and queues nothing more.
    expect(await place(on, `wamid.p8.on.${on}`)).toBe(false);
    const jobs = (await db.query(`SELECT dedupe_key,payload FROM jobs WHERE type='commerce.prepare_whatsapp_order' AND tenant_id=$1`, [accountA])).rows;
    expect(jobs).toEqual([{ dedupe_key: `prep:${on}`, payload: { orderId: on } }]);
    await db.query(`DELETE FROM jobs WHERE type='commerce.prepare_whatsapp_order' AND tenant_id=$1`, [accountA]);
  });
});
