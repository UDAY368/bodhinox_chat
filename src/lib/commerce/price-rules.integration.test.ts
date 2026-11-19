import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@/lib/auth/errors';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { recordOfflinePayment } from '@/lib/payments/offline';
import { expireReservation, placeOrder } from './checkout';
import { applyOrderTenderTx, earnForOrderTx, reverseOrderTenderTx } from './customer-ledger';
import { handleIssueReceiptJob } from './documents';
import { createManualOrder } from './manual-orders';
import { cancelAndRefund } from './order-lifecycle';
import {
  createCustomerGroup, createDiscountRule, createGiftRule, createPriceList, deleteCustomerGroup, deleteDiscountRule, deleteGiftRule, deletePriceList,
  listCustomerGroups, listDiscountRules, listGiftRules, listPriceLists, parseCustomerGroup, parseDiscountRule, parseGiftRule, parsePriceList,
  setGroupMember, updateDiscountRule, updatePriceList,
} from './price-rules-store';
import type { Quote } from './pricing';
import { adjustBalance, getContactBalances, getLoyaltySettings, parseAdjust, parseLoyaltySettings, refundToStoreCredit, saveLoyaltySettings } from './store-credit';
import {
  applyCouponTx, issueSessionTx, loadOrderView, loadSession, loadStorefrontView, quoteSessionTx, setAddressTx, setPaymentMethodTx, setTenderTx, updateCartTx,
} from './storefront';

// Store plan Phase 8 batch 4 on PostgreSQL: price lists, discount rules, free gifts, store credit and loyalty
// points. The quote and the stored order always agree; only admins write rules, settings and adjustments; another
// workspace sees and changes nothing; credit and points cannot be overspent or spent, earned or returned twice.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const account = randomUUID(), other = randomUUID(), owner = randomUUID();
const category = randomUUID(), childCategory = randomUUID();
const productA = randomUUID(), variantA = randomUUID(), productB = randomUUID(), variantB = randomUUID(), productG = randomUUID(), variantG = randomUUID();
const otherProduct = randomUUID(), otherVariant = randomUUID(), otherGroup = randomUUID(), otherContact = randomUUID();
const wholesaleGroup = randomUUID(), wholesaleTag = randomUUID();
const contacts = Array.from({ length: 14 }, () => randomUUID());
const [regular, wholesale, ruleBuyer, giftBuyer, giftLate, spender, racer, creditPayer, pointsBuyer, adjusted] = contacts;
let db: pg.Client;

const admin = { accountId: account, userId: owner, role: 'admin' as const };
const agent = { ...admin, role: 'agent' as const };
const staffOwner = { ...admin, role: 'owner' as const };
const otherAdmin = { accountId: other, userId: owner, role: 'admin' as const };
const worker = <T,>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: account, role: 'owner' }, fn, getWorkerPrisma());
const ADDRESS = { name: 'Buyer', phone: '+919876543210', line1: '1 MG Road', city: 'Bengaluru', postal_code: '560001', country: 'IN' };
const one = async <T,>(sql: string, values: unknown[]): Promise<T> => (await db.query(sql, values)).rows[0] as T;

interface Shop { sessionId: string; version: number; quote: Quote }

/** A shop session with these lines and an address, then the choices; returns its current version and quote. */
async function shop(contactId: string, lines: Array<{ variantId: string; qty: number }>,
  options: { cod?: boolean; credit?: boolean; points?: boolean; coupon?: string } = {}): Promise<Shop> {
  const sessionId = randomUUID();
  await worker((tx) => issueSessionTx(tx, account, {
    sessionId, contactId, conversationId: null, whatsappConfigId: null, purpose: 'shop', orderId: null, ttlHours: 24, createdBy: null,
  }));
  const version = async () => (await worker((tx) => loadSession(tx, account, sessionId)))!.version;
  await worker(async (tx) => updateCartTx(tx, account, sessionId, { expectedVersion: 1, lines }));
  await worker(async (tx) => setAddressTx(tx, account, sessionId, { expectedVersion: 2, address: ADDRESS }));
  if (options.cod) { const v = await version(); await worker((tx) => setPaymentMethodTx(tx, account, sessionId, { expectedVersion: v, paymentMethod: 'cod' })); }
  if (options.coupon) { const v = await version(); await worker((tx) => applyCouponTx(tx, account, sessionId, { expectedVersion: v, code: options.coupon })); }
  if (options.credit || options.points) {
    const v = await version();
    await worker((tx) => setTenderTx(tx, account, sessionId, { expectedVersion: v, useStoreCredit: options.credit === true, usePoints: options.points === true }));
  }
  return { sessionId, version: await version(), quote: await requote(sessionId) };
}

async function requote(sessionId: string): Promise<Quote> {
  const result = await worker(async (tx) => (await quoteSessionTx(tx, account, (await loadSession(tx, account, sessionId))!)).result);
  if (!result.ok) throw new Error(`quote refused: ${result.code}`);
  return result.quote;
}

const place = (s: Shop, extra: { payable?: number | null } = {}) => placeOrder(account, s.sessionId, {
  expectedVersion: s.version, expectedTotalMinor: s.quote.totalMinor, clientRequestId: randomUUID(),
  ...(extra.payable === null ? {} : { expectedPayableMinor: extra.payable ?? s.quote.payableMinor }),
});

interface OrderRow {
  status: string; subtotal_minor: string; discount_minor: string; auto_discount_minor: string; shipping_minor: string; tax_minor: string;
  total_minor: string; amount_paid_minor: string; store_credit_minor: string; points_redeemed: number; points_value_minor: string; paid_at: Date | null;
  discount_details: Array<{ name: string; kind: string; saving_minor: number }> | null;
}
const orderRow = (orderId: string) => one<OrderRow>('SELECT * FROM orders WHERE id=$1', [orderId]);
const items = async (orderId: string) => (await db.query(
  'SELECT sku, quantity, unit_price_minor::int AS unit, discount_minor::int AS discount, line_total_minor::int AS total, tax_minor::int AS tax, is_gift FROM order_items WHERE order_id=$1 ORDER BY is_gift, sku', [orderId])).rows as
  Array<{ sku: string; quantity: number; unit: number; discount: number; total: number; tax: number; is_gift: boolean }>;
const credit = async (contactId: string) => Number((await one<{ b: string }>('SELECT COALESCE(sum(amount_minor),0) AS b FROM shop_credit_ledger WHERE contact_id=$1', [contactId])).b);
const points = async (contactId: string) => Number((await one<{ b: string }>('SELECT COALESCE(sum(points),0) AS b FROM shop_points_ledger WHERE contact_id=$1', [contactId])).b);

/** The stored order holds exactly the numbers the quote showed. */
async function expectOrderMatchesQuote(orderId: string, quote: Quote): Promise<void> {
  const row = await orderRow(orderId);
  expect({
    subtotal: Number(row.subtotal_minor), discount: Number(row.discount_minor), auto: Number(row.auto_discount_minor), shipping: Number(row.shipping_minor),
    tax: Number(row.tax_minor), total: Number(row.total_minor), credit: Number(row.store_credit_minor), points: row.points_redeemed, pointsValue: Number(row.points_value_minor),
  }).toEqual({
    subtotal: quote.subtotalMinor, discount: quote.discountMinor, auto: quote.autoDiscountMinor, shipping: quote.shippingMinor, tax: quote.taxMinor,
    total: quote.totalMinor, credit: quote.storeCreditMinor, points: quote.pointsRedeemed, pointsValue: quote.pointsValueMinor,
  });
  const lines = await items(orderId);
  expect(lines.reduce((n, l) => n + l.discount, 0)).toBe(quote.discountMinor);
  expect(lines.map((l) => [l.sku, l.quantity, l.unit, l.discount, l.total, l.is_gift]).sort())
    .toEqual(quote.lines.map((l) => [l.sku, l.qty, l.unitPriceMinor, l.discountMinor, l.lineTotalMinor, l.gift]).sort());
  // What is still due is the total minus what credit and points (and later money) paid.
  expect(Number(row.total_minor) - Number(row.amount_paid_minor)).toBe(quote.payableMinor);
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('store phase 8 price rules, credit and points on PostgreSQL', { timeout: 180_000 }, () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    const q = (sql: string, values: unknown[]) => db.query(sql, values);
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid,$2,'P8 rules','test-only-hash')", [owner, `${owner}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P8 rules',$3),($2,'P8 other',$3)", [account, other, owner]);
    await q("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [account, other]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$3,'owner'),($2,$3,'owner')", [account, other, owner]);
    await q(`INSERT INTO contacts(id,account_id,user_id,name,phone)
      SELECT c, $2, $3, 'Buyer', '1415888' || lpad(n::text, 4, '0') FROM unnest($1::uuid[]) WITH ORDINALITY AS t(c, n)`, [contacts, account, owner]);
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Other buyer','14158889999')", [otherContact, other, owner]);
    await q("INSERT INTO shop_customer_groups(id,account_id,name) VALUES($1,$2,'Wholesale'),($3,$4,'Other group')", [wholesaleGroup, account, otherGroup, other]);
    await q('INSERT INTO shop_customer_group_members(account_id,group_id,contact_id) VALUES($1,$2,$3)', [account, wholesaleGroup, wholesale]);
    // A contact tag of the same name gives nothing: the regular buyer carries it throughout and always pays catalogue prices.
    await q("INSERT INTO tags(id,account_id,user_id,name) VALUES($1,$2,$3,'Wholesale')", [wholesaleTag, account, owner]);
    await q('INSERT INTO contact_tags(account_id,contact_id,tag_id) VALUES($1,$2,$3)', [account, regular, wholesaleTag]);
    await q(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,cod_enabled,cod_fee_minor)
      VALUES($1,'INR',false,500,true,true,0),($2,'INR',false,500,true,false,0)`, [account, other]);
    await q(`INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc) VALUES($1,'razorpay','test','rzp_test_P8PR','enc')`, [account]);
    await q(`INSERT INTO shipping_rates(account_id,name,country,fee_minor,tax_rate_bps) VALUES($1,'India','IN',6000,0)`, [account]);
    await q(`INSERT INTO shop_categories(id,account_id,name,parent_id) VALUES($1,$3,'Herbs',NULL),($2,$3,'Powders',$1)`, [category, childCategory, account]);
    await q(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at,category_id)
      VALUES($1,$4,'Triphala','published',now(),$5),($2,$4,'Soap','published',now(),NULL),($3,$4,'Sample sachet','published',now(),NULL)`,
    [productA, productB, productG, account, childCategory]);
    await q(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Other item','published',now())`, [otherProduct, other]);
    await q(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$7,$2,'TRI-100',20000),($3,$7,$4,'SOAP-1',5000),($5,$7,$6,'GIFT-1',1000)`,
      [variantA, productA, variantB, productB, variantG, productG, account]);
    await q(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'OTHER-1',100)`, [otherVariant, other, otherProduct]);
    await q(`INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,500),($1,$3,500),($1,$4,2)`, [account, variantA, variantB, variantG]);
    await q(`INSERT INTO coupons(account_id,code,kind,value) VALUES($1,'TENOFF','percent',1000)`, [account]);
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

  const listInput = (prices: Array<{ variant_id: string; min_qty: number; price_minor: number }>, extra: Record<string, unknown> = {}) =>
    parsePriceList({ name: 'Wholesale prices', group_id: wholesaleGroup, active: true, prices, ...extra });
  const ruleInput = (body: Record<string, unknown>) => parseDiscountRule({ name: 'Rule', kind: 'percent', value: 1000, combinable: true, active: true, ...body });
  const giftInput = (body: Record<string, unknown>) => parseGiftRule({ name: 'Free sachet', gift_variant_id: variantG, active: true, ...body });

  it('lets only admins write rules and settings, and refuses another workspace\'s rows and bad shapes', async () => {
    const prices = [{ variant_id: variantA, min_qty: 1, price_minor: 18_000 }];
    await expect(createPriceList(agent, listInput(prices))).rejects.toThrow();
    await expect(createDiscountRule(agent, ruleInput({ product_id: productA }))).rejects.toThrow();
    await expect(createGiftRule(agent, giftInput({ min_subtotal_minor: 30_000 }))).rejects.toThrow();
    await expect(saveLoyaltySettings(agent, parseLoyaltySettings({ enabled: true, earn_points: 1, earn_spend_minor: 1000, redeem_value_minor: 100, redeem_max_bps: 5000 }))).rejects.toThrow();
    expect(await listPriceLists(agent)).toEqual([]);
    expect((await getLoyaltySettings(agent)).enabled).toBe(false);
    // The worker prices with the rules but cannot write them.
    await expect(worker((tx) => tx.$executeRaw`INSERT INTO shop_discount_rules(account_id,name,product_id,kind,value)
      VALUES(${account}::uuid,'x',${productA}::uuid,'percent',9000)`)).rejects.toThrow();
    await expect(worker((tx) => tx.$executeRaw`INSERT INTO shop_loyalty_settings(account_id,enabled) VALUES(${account}::uuid,true)`)).rejects.toThrow();

    // Another workspace's group, product, category or variant cannot be named.
    await expect(createPriceList(admin, listInput(prices, { group_id: otherGroup }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(createPriceList(admin, listInput([{ variant_id: otherVariant, min_qty: 1, price_minor: 1 }]))).rejects.toMatchObject({ code: 'invalid' });
    await expect(createDiscountRule(admin, ruleInput({ product_id: otherProduct }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(createGiftRule(admin, giftInput({ min_subtotal_minor: 1, gift_variant_id: otherVariant }))).rejects.toMatchObject({ code: 'invalid' });
    // Fixed shapes only.
    expect(() => ruleInput({})).toThrow();
    expect(() => ruleInput({ product_id: productA, category_id: category })).toThrow();
    expect(() => ruleInput({ product_id: productA, value: 10_001 })).toThrow();
    expect(() => ruleInput({ product_id: productA, name: '<b>x</b>' })).toThrow();
    expect(() => giftInput({})).toThrow();
    expect(() => giftInput({ min_subtotal_minor: 1, trigger_product_id: productA })).toThrow();
    expect(() => listInput([...prices, ...prices])).toThrow();
    expect(() => parseLoyaltySettings({ enabled: true, earn_points: 0, earn_spend_minor: 1000, redeem_value_minor: 100, redeem_max_bps: 5000 })).toThrow();
    await expect(db.query(`INSERT INTO shop_gift_rules(account_id,name,gift_variant_id) VALUES($1,'x',$2)`, [account, variantG])).rejects.toThrow(/check/);
    await expect(db.query(`INSERT INTO shop_discount_rules(account_id,name,kind,value) VALUES($1,'x','percent',100)`, [account])).rejects.toThrow(/check/);

    // An admin creates, edits with a version check and deletes; the other workspace sees and changes nothing.
    const list = await createPriceList(admin, listInput(prices));
    const made = await createDiscountRule(admin, ruleInput({ product_id: productA }));
    expect(await listPriceLists(otherAdmin)).toEqual([]);
    expect(await listDiscountRules(otherAdmin)).toEqual([]);
    expect(await listGiftRules(otherAdmin)).toEqual([]);
    await expect(updateDiscountRule(otherAdmin, made.id, 1, { ...ruleInput({ product_id: productA }), product_id: null, group_id: otherGroup })).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteDiscountRule(otherAdmin, made.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(deletePriceList(otherAdmin, list.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(updateDiscountRule(admin, made.id, 7, ruleInput({ product_id: productA }))).rejects.toMatchObject({ code: 'conflict' });
    expect((await updateDiscountRule(admin, made.id, 1, ruleInput({ product_id: productA, value: 500 }))).version).toBe(2);
    const audit = await db.query(`SELECT action, metadata FROM audit_logs WHERE account_id=$1 AND resource_id=$2 ORDER BY created_at`, [account, made.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['commerce.discount_rule_created', 'commerce.discount_rule_updated']);
    await deleteDiscountRule(admin, made.id);
    await deletePriceList(admin, list.id);
    expect(await listDiscountRules(admin)).toEqual([]);
    expect(await listPriceLists(admin)).toEqual([]);
  });

  it('lets only an admin decide who is in a price group: an agent, the worker and a contact tag cannot', async () => {
    // An agent cannot make a group or put a contact into one (the route requires admin; the table refuses it too).
    await expect(createCustomerGroup(agent, parseCustomerGroup({ name: 'Agent made' }))).rejects.toThrow();
    await expect(setGroupMember(agent, wholesaleGroup, regular, true)).rejects.toThrow();
    await expect(withTenant(agent, (tx) => tx.$executeRaw`INSERT INTO shop_customer_group_members(account_id,group_id,contact_id)
      VALUES(${account}::uuid,${wholesaleGroup}::uuid,${regular}::uuid)`)).rejects.toThrow();
    await expect(withTenant(agent, (tx) => tx.$executeRaw`UPDATE shop_customer_group_members SET contact_id=${regular}::uuid
      WHERE group_id=${wholesaleGroup}::uuid`)).rejects.toThrow();
    // Nor can an agent take a member out, or the worker (public checkout, jobs) change membership at all.
    await setGroupMember(agent, wholesaleGroup, wholesale, false).catch(() => undefined);
    await expect(worker((tx) => tx.$executeRaw`INSERT INTO shop_customer_group_members(account_id,group_id,contact_id)
      VALUES(${account}::uuid,${wholesaleGroup}::uuid,${regular}::uuid)`)).rejects.toThrow();
    expect((await db.query('SELECT contact_id::text AS id FROM shop_customer_group_members WHERE group_id=$1', [wholesaleGroup])).rows).toEqual([{ id: wholesale }]);
    // An agent can read the groups (to see why a price applies).
    expect((await listCustomerGroups(agent)).map((g) => [g.name, g.member_count])).toEqual([['Wholesale', 1]]);

    // An admin can; names are unique; a contact or group of another workspace is refused; a repeat changes nothing.
    const vip = await createCustomerGroup(admin, parseCustomerGroup({ name: 'VIP' }));
    await expect(createCustomerGroup(admin, parseCustomerGroup({ name: 'vip' }))).rejects.toMatchObject({ code: 'invalid' });
    expect((await setGroupMember(admin, vip.id, ruleBuyer, true)).member_count).toBe(1);
    expect((await setGroupMember(admin, vip.id, ruleBuyer, true)).member_count).toBe(1);
    await expect(setGroupMember(admin, vip.id, otherContact, true)).rejects.toMatchObject({ code: 'invalid' });
    await expect(setGroupMember(otherAdmin, vip.id, otherContact, true)).rejects.toMatchObject({ code: 'not_found' });
    await expect(setGroupMember(otherAdmin, otherGroup, ruleBuyer, true)).rejects.toMatchObject({ code: 'invalid' });
    await expect(deleteCustomerGroup(otherAdmin, vip.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await listCustomerGroups(otherAdmin)).map((g) => g.name)).toEqual(['Other group']);
    await deleteCustomerGroup(admin, vip.id);
    expect(await one('SELECT count(*)::int AS n FROM shop_customer_group_members WHERE group_id=$1', [vip.id])).toEqual({ n: 0 });
  });

  it('gives the wholesale price list only to contacts in the group, in the quote, the order and a manual order', async () => {
    const list = await createPriceList(admin, listInput([
      { variant_id: variantA, min_qty: 1, price_minor: 18_000 }, { variant_id: variantA, min_qty: 3, price_minor: 16_000 },
    ]));
    ids.list = list.id;
    expect(list.prices.map((p) => [p.sku, p.min_qty, p.price_minor])).toEqual([['TRI-100', 1, 18_000], ['TRI-100', 3, 16_000]]);
    const lines = [{ variantId: variantA, qty: 3 }];
    const plain = await shop(regular, lines);
    expect(plain.quote.lines[0]).toMatchObject({ unitPriceMinor: 20_000, grossMinor: 60_000 });
    // (A new shop link revokes the contact's earlier one, so the cart that is placed is made last.)
    const two = await shop(wholesale, [{ variantId: variantA, qty: 2 }]);
    expect(two.quote.lines[0].unitPriceMinor).toBe(18_000);
    const ws = await shop(wholesale, lines);
    // 3 × 16000 = 48000, tax 5% = 2400, shipping 6000.
    expect(ws.quote).toMatchObject({ subtotalMinor: 48_000, discountMinor: 0, taxMinor: 2_400, shippingMinor: 6_000, totalMinor: 56_400, payableMinor: 56_400 });
    expect(ws.quote.lines[0]).toMatchObject({ unitPriceMinor: 16_000, catalogPriceMinor: 20_000 });

    const { orderId } = await place(ws);
    await expectOrderMatchesQuote(orderId, ws.quote);
    expect((await items(orderId))[0]).toMatchObject({ unit: 16_000, total: 50_400 });

    // Staff making the order for the same customer get the same price; for another customer, the catalogue price.
    const manual = await createManualOrder(staffOwner, { contactId: wholesale, lines, note: null, clientRequestId: randomUUID() });
    expect(Number((await orderRow(manual.orderId)).subtotal_minor)).toBe(48_000);
    const manualPlain = await createManualOrder(staffOwner, { contactId: regular, lines, note: null, clientRequestId: randomUUID() });
    expect(Number((await orderRow(manualPlain.orderId)).subtotal_minor)).toBe(60_000);

    // Switched off, or the contact taken out of the group by an admin: the catalogue price again.
    await updatePriceList(admin, list.id, 1, listInput([{ variant_id: variantA, min_qty: 1, price_minor: 18_000 }], { active: false }));
    expect((await requote(two.sessionId)).lines[0].unitPriceMinor).toBe(20_000);
    await updatePriceList(admin, list.id, 2, listInput([{ variant_id: variantA, min_qty: 1, price_minor: 18_000 }]));
    expect((await requote(two.sessionId)).lines[0].unitPriceMinor).toBe(18_000);
    expect((await setGroupMember(admin, wholesaleGroup, wholesale, false)).member_count).toBe(0);
    expect((await requote(two.sessionId)).lines[0].unitPriceMinor).toBe(20_000);
    expect((await setGroupMember(admin, wholesaleGroup, wholesale, true)).members.map((m) => m.contact_id)).toEqual([wholesale]);
    expect((await requote(two.sessionId)).lines[0].unitPriceMinor).toBe(18_000);
  });

  it('stacks rules, the coupon and a group rule the same way in the quote and the stored order', async () => {
    // The product sits in a sub-category of the rule's category.
    const byCategory = await createDiscountRule(admin, ruleInput({ name: 'Herbs 10%', category_id: category }));
    const groupOnly = await createDiscountRule(admin, ruleInput({ name: 'Wholesale extra', group_id: wholesaleGroup, kind: 'fixed', value: 500 }));
    const s = await shop(ruleBuyer, [{ variantId: variantA, qty: 2 }, { variantId: variantB, qty: 1 }], { coupon: 'TENOFF' });
    // A: 40000 − 10% = 36000. B: 5000. Coupon 10% of 41000 = 4100. The group rule is not for this buyer.
    expect(s.quote).toMatchObject({ subtotalMinor: 45_000, ruleDiscountMinor: 4_000, autoDiscountMinor: 4_000, discountMinor: 8_100, couponCode: 'TENOFF' });
    expect(s.quote.autoDiscounts).toEqual([{ id: byCategory.id, name: 'Herbs 10%', kind: 'price_rule', savingMinor: 4_000 }]);
    const { orderId } = await place(s);
    await expectOrderMatchesQuote(orderId, s.quote);
    expect((await orderRow(orderId)).discount_details).toEqual([{ name: 'Herbs 10%', kind: 'price_rule', saving_minor: 4_000 }]);
    const view = await worker((tx) => loadOrderView(tx, account, orderId));
    expect(view).toMatchObject({ discountMinor: 8_100, autoDiscountMinor: 4_000, autoDiscounts: [{ name: 'Herbs 10%', kind: 'price_rule', savingMinor: 4_000 }] });

    // The wholesale buyer: list price 18000 × 2 = 36000, category 10% = 3600 and the group rule 500 × 2 = 1000 on A; 500 on B.
    const ws = await shop(wholesale, [{ variantId: variantA, qty: 2 }, { variantId: variantB, qty: 1 }]);
    expect(ws.quote).toMatchObject({ subtotalMinor: 41_000, ruleDiscountMinor: 5_100, discountMinor: 5_100 });
    const wsOrder = await place(ws);
    await expectOrderMatchesQuote(wsOrder.orderId, ws.quote);

    // A rule that does not combine wins only when it is cheaper for the buyer: 50% alone beats 10% plus the coupon.
    const exclusive = await createDiscountRule(admin, ruleInput({ name: 'Half off Triphala', product_id: productA, value: 5000, combinable: false }));
    const again = await shop(regular, [{ variantId: variantA, qty: 2 }, { variantId: variantB, qty: 1 }], { coupon: 'TENOFF' });
    // A: 40000 − 20000, closed. B: coupon 10% of 5000 = 500.
    expect(again.quote).toMatchObject({ ruleDiscountMinor: 20_000, discountMinor: 20_500 });
    expect(again.quote.lines.map((l) => l.discountMinor)).toEqual([20_000, 500]);
    const exclusiveOrder = await place(again);
    await expectOrderMatchesQuote(exclusiveOrder.orderId, again.quote);
    for (const id of [byCategory.id, groupOnly.id, exclusive.id]) await deleteDiscountRule(admin, id);
  });

  it('adds a free gift as a stock-checked line at 0 and drops it when the condition or the stock is gone', async () => {
    const rule = await createGiftRule(admin, giftInput({ min_subtotal_minor: 30_000 }));
    const small = await shop(giftBuyer, [{ variantId: variantA, qty: 1 }], { cod: true });
    expect(small.quote.lines.filter((l) => l.gift)).toEqual([]);
    const s = await shop(giftBuyer, [{ variantId: variantA, qty: 2 }], { cod: true });
    expect(s.quote.lines).toHaveLength(2);
    expect(s.quote.lines[1]).toMatchObject({ variantId: variantG, gift: true, giftName: 'Free sachet', qty: 1, unitPriceMinor: 0, lineTotalMinor: 0 });
    // The gift costs nothing: the total is the same as without it.
    expect(s.quote.totalMinor).toBe(40_000 + 2_000 + 6_000);
    const { orderId } = await place(s);
    await expectOrderMatchesQuote(orderId, s.quote);
    expect((await items(orderId)).at(-1)).toMatchObject({ sku: 'GIFT-1', is_gift: true, unit: 0, total: 0, quantity: 1 });
    // Held through the normal stock path.
    expect(await one('SELECT reserved FROM inventory_levels WHERE variant_id=$1', [variantG])).toEqual({ reserved: 1 });
    expect((await worker((tx) => loadOrderView(tx, account, orderId)))!.lines.filter((l) => l.gift)).toHaveLength(1);

    // One unit left: the next buyer still gets it; with none left the gift is simply not offered and the order goes through.
    const second = await shop(giftLate, [{ variantId: variantA, qty: 2 }], { cod: true });
    expect(second.quote.lines.filter((l) => l.gift)).toHaveLength(1);
    await db.query('UPDATE inventory_levels SET on_hand=1 WHERE variant_id=$1', [variantG]);
    const stale = await placeOrder(account, second.sessionId, {
      expectedVersion: second.version, expectedTotalMinor: second.quote.totalMinor, clientRequestId: randomUUID(),
    });
    expect((await items(stale.orderId)).filter((l) => l.is_gift)).toEqual([]);
    expect((await requote((await shop(regular, [{ variantId: variantA, qty: 2 }], { cod: true })).sessionId)).lines.filter((l) => l.gift)).toEqual([]);
    await deleteGiftRule(admin, rule.id);
    await db.query('UPDATE inventory_levels SET on_hand=50 WHERE variant_id=$1', [variantG]);
  });

  it('keeps store credit in an append-only ledger that only an admin adjusts, with a reason, once per request', async () => {
    const request = randomUUID();
    const body = { contact_id: adjusted, ledger: 'credit', amount: 10_000, reason: 'Goodwill', client_request_id: request };
    await expect(adjustBalance(agent, parseAdjust(body))).rejects.toThrow();
    expect(() => parseAdjust({ ...body, reason: '' })).toThrow();
    expect(() => parseAdjust({ ...body, amount: 0 })).toThrow();
    expect(() => parseAdjust({ ...body, amount: 1.5 })).toThrow();
    expect(await adjustBalance(admin, parseAdjust(body))).toEqual({ balance: 10_000, created: true });
    // A repeated click is one entry.
    expect(await adjustBalance(admin, parseAdjust(body))).toEqual({ balance: 10_000, created: false });
    expect(await credit(adjusted)).toBe(10_000);
    // Never below zero: refused by the code, and by the table even if code let it through.
    await expect(adjustBalance(admin, parseAdjust({ ...body, amount: -10_001, client_request_id: randomUUID() }))).rejects.toMatchObject({ code: 'store_credit_insufficient' });
    await expect(db.query(`INSERT INTO shop_credit_ledger(account_id,contact_id,amount_minor,currency,kind,dedupe_key) VALUES($1,$2,-10001,'INR','spend',$3)`,
      [account, adjusted, randomUUID()])).rejects.toThrow(/store_credit_insufficient/);
    expect(await adjustBalance(admin, parseAdjust({ ...body, amount: -4_000, client_request_id: randomUUID() }))).toEqual({ balance: 6_000, created: true });
    // An agent reads the balance and its entries; the reason stays in the ledger, not in the audit log.
    const seen = await getContactBalances(agent, adjusted);
    expect(seen).toMatchObject({ store_credit_minor: 6_000, points: 0, currency: 'INR' });
    expect(seen.credit_entries.map((e) => [e.kind, e.amount, e.reason]).sort()).toEqual([['adjust', -4_000, 'Goodwill'], ['adjust', 10_000, 'Goodwill']]);
    const audit = await db.query(`SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='commerce.store_credit_adjusted'`, [account]);
    expect(audit.rows.map((r) => r.metadata).sort((a, b) => a.amount - b.amount)).toEqual([{ amount: -4_000 }, { amount: 10_000 }]);

    // Nobody edits or deletes an entry, and an app-role admin can add nothing but an adjustment.
    const app = <T,>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant(admin, fn);
    await expect(app((tx) => tx.$executeRaw`UPDATE shop_credit_ledger SET amount_minor=999999 WHERE contact_id=${adjusted}::uuid`)).rejects.toThrow();
    await expect(app((tx) => tx.$executeRaw`DELETE FROM shop_credit_ledger WHERE contact_id=${adjusted}::uuid`)).rejects.toThrow();
    await expect(worker((tx) => tx.$executeRaw`UPDATE shop_credit_ledger SET amount_minor=999999 WHERE contact_id=${adjusted}::uuid`)).rejects.toThrow();
    await expect(worker((tx) => tx.$executeRaw`DELETE FROM shop_points_ledger WHERE contact_id=${adjusted}::uuid`)).rejects.toThrow();
    await expect(app((tx) => tx.$executeRaw`INSERT INTO shop_credit_ledger(account_id,contact_id,amount_minor,currency,kind,dedupe_key)
      VALUES(${account}::uuid,${adjusted}::uuid,500000,'INR','refund',${randomUUID()})`)).rejects.toThrow();
    await expect(withTenant(agent, (tx) => tx.$executeRaw`INSERT INTO shop_credit_ledger(account_id,contact_id,amount_minor,currency,kind,reason,dedupe_key,created_by)
      VALUES(${account}::uuid,${adjusted}::uuid,500000,'INR','adjust','x',${randomUUID()},${owner}::uuid)`)).rejects.toThrow();
    expect(await credit(adjusted)).toBe(6_000);

    // Another workspace cannot see or touch the contact's balance.
    await expect(getContactBalances(otherAdmin, adjusted)).rejects.toMatchObject({ code: 'contact_not_found' });
    await expect(adjustBalance(otherAdmin, parseAdjust({ ...body, client_request_id: randomUUID() }))).rejects.toMatchObject({ code: 'contact_not_found' });
    const leaked = await withTenant({ accountId: other, role: 'owner' }, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shop_credit_ledger`, getWorkerPrisma());
    expect(leaked[0].n).toBe(0);
    await expect(withTenant({ accountId: other, role: 'owner' }, (tx) => tx.$executeRaw`INSERT INTO shop_credit_ledger(account_id,contact_id,amount_minor,currency,kind,dedupe_key)
      VALUES(${account}::uuid,${adjusted}::uuid,500000,'INR','refund',${randomUUID()})`, getWorkerPrisma())).rejects.toThrow();
  });

  it('spends store credit at checkout once, and gives it back once when the order expires unpaid', async () => {
    await adjustBalance(admin, parseAdjust({ contact_id: spender, ledger: 'credit', amount: 10_000, reason: 'Refund of an old order', client_request_id: randomUUID() }));
    const view = await worker(async (tx) => loadStorefrontView(tx, account, (await shop(spender, [{ variantId: variantA, qty: 1 }])).sessionId));
    expect(view?.wallet).toEqual({ storeCreditMinor: 10_000, points: 0, pointValueMinor: null, useStoreCredit: false, usePoints: false });
    const s = await shop(spender, [{ variantId: variantA, qty: 1 }], { credit: true });
    // 20000 + tax 1000 + shipping 6000 = 27000; credit pays 10000. The total and the tax do not change.
    expect(s.quote).toMatchObject({ totalMinor: 27_000, taxMinor: 1_000, storeCreditMinor: 10_000, payableMinor: 17_000 });
    // A client that did not show the credit cannot place a credit-paying order.
    await expect(place(s, { payable: null })).rejects.toMatchObject({ code: 'quote_changed' });
    await expect(place(s, { payable: 16_999 })).rejects.toMatchObject({ code: 'quote_changed' });
    expect(await credit(spender)).toBe(10_000);
    const first = await place(s);
    ids.unpaid = first.orderId;
    expect(first.created).toBe(true);
    await expectOrderMatchesQuote(first.orderId, s.quote);
    expect(await orderRow(first.orderId)).toMatchObject({ status: 'awaiting_payment', amount_paid_minor: '10000', store_credit_minor: '10000' });
    expect(await credit(spender)).toBe(0);
    // The payment link is made for what is left to pay.
    expect(await one(`SELECT count(*)::int AS n FROM jobs WHERE dedupe_key=$1`, [`colink:${first.orderId}:1`])).toEqual({ n: 1 });

    // A replayed place and a replayed spend change nothing.
    expect(await place(s)).toEqual({ orderId: first.orderId, created: false });
    await worker((tx) => applyOrderTenderTx(tx, account, { orderId: first.orderId, contactId: spender, currency: 'INR', creditMinor: 10_000, points: 0 }));
    expect(await one('SELECT count(*)::int AS n FROM shop_credit_ledger WHERE order_id=$1', [first.orderId])).toEqual({ n: 1 });
    expect(await credit(spender)).toBe(0);

    // The hold runs out with no payment: the credit comes back, once, and nothing counts as paid.
    await db.query(`UPDATE orders SET reservation_expires_at=now() - interval '5 minutes' WHERE id=$1`, [first.orderId]);
    await expireReservation(account, { orderId: first.orderId, attempt: 1 });
    expect(await orderRow(first.orderId)).toMatchObject({ status: 'expired', amount_paid_minor: '0', store_credit_minor: '10000' });
    expect(await credit(spender)).toBe(10_000);
    await expireReservation(account, { orderId: first.orderId, attempt: 1 });
    expect(await worker((tx) => reverseOrderTenderTx(tx, account, first.orderId))).toEqual({ creditMinor: 0, points: 0 });
    expect(await credit(spender)).toBe(10_000);
    expect((await db.query('SELECT kind, amount_minor::int AS amount FROM shop_credit_ledger WHERE order_id=$1 ORDER BY created_at, kind', [first.orderId])).rows)
      .toEqual([{ kind: 'spend', amount: -10_000 }, { kind: 'spend_reversal', amount: 10_000 }]);
  });

  it('never lets two checkouts or two writers spend the same credit', async () => {
    await adjustBalance(admin, parseAdjust({ contact_id: racer, ledger: 'credit', amount: 30_000, reason: 'Race', client_request_id: randomUUID() }));
    const a = await shop(racer, [{ variantId: variantA, qty: 1 }], { credit: true });
    const b = await shop(racer, [{ variantId: variantA, qty: 1 }], { credit: true });
    // A new shop link revokes the earlier one; bring it back to stand for two carts of one contact placed together
    // (a shop cart and a WhatsApp cart).
    await db.query('UPDATE storefront_sessions SET revoked_at=NULL WHERE id=$1', [a.sessionId]);
    // Both carts were shown the whole order paid by credit (27000 of 30000).
    expect([a.quote.payableMinor, b.quote.payableMinor]).toEqual([0, 0]);
    const results = await Promise.allSettled([place(a), place(b)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'quote_changed' });
    expect(await credit(racer)).toBe(3_000);
    expect(await one(`SELECT count(*)::int AS n FROM orders WHERE contact_id=$1 AND priced_at IS NOT NULL`, [racer])).toEqual({ n: 1 });

    // Under the ledger itself: two transactions each taking 2000 of the 3000 left. One commits, the other is refused.
    const take = (key: string) => worker(async (tx) => {
      await tx.$executeRaw`INSERT INTO shop_credit_ledger(account_id,contact_id,amount_minor,currency,kind,dedupe_key)
        VALUES(${account}::uuid,${racer}::uuid,-2000,'INR','spend',${key})`;
      await tx.$queryRaw`SELECT pg_sleep(0.3)::text AS slept`;
    });
    const raw = await Promise.allSettled([take(randomUUID()), take(randomUUID())]);
    expect(raw.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await credit(racer)).toBe(1_000);
    // Two admins taking the last 1000 at once: one entry.
    const adjust = () => adjustBalance(admin, parseAdjust({ contact_id: racer, ledger: 'credit', amount: -1_000, reason: 'Race', client_request_id: randomUUID() }));
    const both = await Promise.allSettled([adjust(), adjust()]);
    expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await credit(racer)).toBe(0);
    // The same dedupe key twice is one entry.
    const key = randomUUID();
    await db.query(`INSERT INTO shop_credit_ledger(account_id,contact_id,amount_minor,currency,kind,dedupe_key) VALUES($1,$2,500,'INR','refund',$3)`, [account, racer, key]);
    await expect(db.query(`INSERT INTO shop_credit_ledger(account_id,contact_id,amount_minor,currency,kind,dedupe_key) VALUES($1,$2,500,'INR','refund',$3)`, [account, racer, key]))
      .rejects.toThrow(/duplicate key/);
  });

  it('confirms an order paid in full by credit at once, earns points once, and unwinds all of it on cancel', async () => {
    await saveLoyaltySettings(admin, parseLoyaltySettings({ enabled: true, earn_points: 1, earn_spend_minor: 1_000, redeem_value_minor: 100, redeem_max_bps: 5_000 }));
    await adjustBalance(admin, parseAdjust({ contact_id: creditPayer, ledger: 'credit', amount: 100_000, reason: 'Wallet top up', client_request_id: randomUUID() }));
    const before = await one<{ on_hand: number; reserved: number }>('SELECT on_hand, reserved FROM inventory_levels WHERE variant_id=$1', [variantA]);
    const s = await shop(creditPayer, [{ variantId: variantA, qty: 1 }], { credit: true });
    expect(s.quote).toMatchObject({ totalMinor: 27_000, storeCreditMinor: 27_000, payableMinor: 0 });
    const { orderId } = await place(s);
    const row = await orderRow(orderId);
    expect(row).toMatchObject({ status: 'paid', amount_paid_minor: '27000', store_credit_minor: '27000', total_minor: '27000' });
    expect(row.paid_at).not.toBeNull();
    await expectOrderMatchesQuote(orderId, s.quote);
    expect(await credit(creditPayer)).toBe(73_000);
    // No payment link and no hold to expire; the sale is committed.
    expect(await one(`SELECT count(*)::int AS n FROM jobs WHERE dedupe_key IN ($1,$2)`, [`colink:${orderId}:1`, `resv-exp:${orderId}:1`])).toEqual({ n: 0 });
    expect(await one('SELECT status FROM stock_reservations WHERE order_id=$1', [orderId])).toEqual({ status: 'committed' });
    // The same receipt a payment gets is queued for the order and issued once, with no payment attached.
    expect(await one(`SELECT count(*)::int AS n FROM jobs WHERE type='commerce.issue_receipt' AND dedupe_key=$1`, [`receipt:order:${orderId}`])).toEqual({ n: 1 });
    await handleIssueReceiptJob(account, { orderId });
    await handleIssueReceiptJob(account, { orderId });
    expect((await db.query(`SELECT kind, payment_id, total_minor::int AS total FROM commerce_documents WHERE order_id=$1`, [orderId])).rows)
      .toEqual([{ kind: 'receipt', payment_id: null, total: 27_000 }]);
    expect((await worker((tx) => loadOrderView(tx, account, orderId)))?.documentNumber).toEqual(expect.any(String));
    // An order with money still to pay gets no such receipt.
    await handleIssueReceiptJob(account, { orderId: ids.unpaid });
    expect(await one(`SELECT count(*)::int AS n FROM commerce_documents WHERE order_id=$1`, [ids.unpaid])).toEqual({ n: 0 });
    // 27000 paid earns 27 points, once: paying again or replaying the earn adds nothing.
    expect(await points(creditPayer)).toBe(27);
    expect(await worker((tx) => earnForOrderTx(tx, account, orderId))).toBe(0);
    expect(await points(creditPayer)).toBe(27);

    // Cancel and refund: no payment to refund, the credit and the stock come back and the points go.
    await expect(cancelAndRefund(agent, orderId)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await cancelAndRefund(admin, orderId)).toEqual({ refundIds: [], refundedOutside: false });
    expect(await orderRow(orderId)).toMatchObject({ status: 'cancelled', amount_paid_minor: '0' });
    expect(await credit(creditPayer)).toBe(100_000);
    expect(await points(creditPayer)).toBe(0);
    expect(await one('SELECT on_hand, reserved FROM inventory_levels WHERE variant_id=$1', [variantA])).toEqual(before);
  });

  it('redeems points up to the cap, earns on what money paid, and takes points back in the share refunded to store credit', async () => {
    await adjustBalance(admin, parseAdjust({ contact_id: pointsBuyer, ledger: 'points', amount: 200, reason: 'Welcome points', client_request_id: randomUUID() }));
    expect((await getContactBalances(agent, pointsBuyer)).points).toBe(200);
    await expect(adjustBalance(admin, parseAdjust({ contact_id: pointsBuyer, ledger: 'points', amount: -201, reason: 'Too many', client_request_id: randomUUID() })))
      .rejects.toMatchObject({ code: 'points_insufficient' });
    await expect(db.query(`INSERT INTO shop_points_ledger(account_id,contact_id,points,kind,dedupe_key) VALUES($1,$2,-201,'redeem',$3)`, [account, pointsBuyer, randomUUID()]))
      .rejects.toThrow(/loyalty_points_insufficient/);
    const s = await shop(pointsBuyer, [{ variantId: variantA, qty: 1 }], { cod: true, points: true });
    // Cap 50% of 27000 = 13500; a point pays 100: 135 points.
    expect(s.quote).toMatchObject({ totalMinor: 27_000, taxMinor: 1_000, pointsRedeemed: 135, pointsValueMinor: 13_500, storeCreditMinor: 0, payableMinor: 13_500 });
    const { orderId } = await place(s);
    await expectOrderMatchesQuote(orderId, s.quote);
    expect(await orderRow(orderId)).toMatchObject({ status: 'confirmed', points_redeemed: 135, points_value_minor: '13500', amount_paid_minor: '13500' });
    expect(await points(pointsBuyer)).toBe(65);
    expect(await place(s)).toEqual({ orderId, created: false });
    expect(await points(pointsBuyer)).toBe(65);

    // The cash arrives: exactly what was left to pay. Points are earned on the money, not on the part points paid.
    await expect(recordOfflinePayment(staffOwner, orderId, { amount: '270', method: 'cash', clientRequestId: randomUUID() })).rejects.toThrow();
    const { paymentId } = await recordOfflinePayment(staffOwner, orderId, { amount: '135', method: 'cash', clientRequestId: randomUUID() });
    expect(await orderRow(orderId)).toMatchObject({ status: 'paid', amount_paid_minor: '27000' });
    expect(await points(pointsBuyer)).toBe(65 + 13);

    // Refund half of the money to store credit: processed at once, the credit grows, half of the earned points go back.
    const request = randomUUID();
    const refund = { paymentId, amountMinor: 6_750, reason: 'customer_request' as const, clientRequestId: request };
    await expect(refundToStoreCredit(agent, refund)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(refundToStoreCredit(otherAdmin, refund)).rejects.toMatchObject({ code: 'not_found' });
    const { refundId } = await refundToStoreCredit(admin, refund);
    expect(await one('SELECT status, source, store_credit, amount_minor::int AS amount FROM customer_refunds WHERE id=$1', [refundId]))
      .toEqual({ status: 'processed', source: 'external', store_credit: true, amount: 6_750 });
    expect(await credit(pointsBuyer)).toBe(6_750);
    expect(await points(pointsBuyer)).toBe(78 - 6);
    expect(Number((await orderRow(orderId) as unknown as { amount_refunded_minor: string }).amount_refunded_minor)).toBe(6_750);
    // The same request again is the same refund: no second credit, no second reversal.
    expect(await refundToStoreCredit(admin, refund)).toEqual({ refundId });
    expect(await credit(pointsBuyer)).toBe(6_750);
    expect(await points(pointsBuyer)).toBe(72);
    // More than the payment has left is refused; the rest takes the remaining earned points back.
    await expect(refundToStoreCredit(admin, { ...refund, amountMinor: 6_751, clientRequestId: randomUUID() })).rejects.toMatchObject({ code: 'amount_exceeds' });
    await refundToStoreCredit(admin, { ...refund, amountMinor: 6_750, clientRequestId: randomUUID() });
    expect(await credit(pointsBuyer)).toBe(13_500);
    expect(await points(pointsBuyer)).toBe(65);
    expect((await db.query(`SELECT kind, points FROM shop_points_ledger WHERE order_id=$1 ORDER BY created_at, kind`, [orderId])).rows)
      .toEqual([{ kind: 'redeem', points: -135 }, { kind: 'earn', points: 13 }, { kind: 'earn_reversal', points: -6 }, { kind: 'earn_reversal', points: -7 }]);

    // With loyalty switched off, points are neither offered nor earned.
    await saveLoyaltySettings(admin, parseLoyaltySettings({ enabled: false, earn_points: 1, earn_spend_minor: 1_000, redeem_value_minor: 100, redeem_max_bps: 5_000 }));
    const off = await shop(pointsBuyer, [{ variantId: variantB, qty: 1 }], { cod: true, points: true });
    expect(off.quote).toMatchObject({ pointsRedeemed: 0, pointsValueMinor: 0 });
  });
});
