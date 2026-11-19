import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Store plan Phase 8, batch 6 on PostgreSQL: shop segments, email campaigns, order confirmation emails, referrals and
// affiliates, and the link-in-bio page. SMTP is a fake transport (nothing leaves); the real jobs, tables, roles and row
// level security run. Campaigns, affiliates and settings are admin-only; another workspace sees and changes nothing; a
// replayed job never sends or rewards twice; an unsubscribe is final; nothing is sent without SMTP.
const mail = vi.hoisted(() => ({ send: vi.fn(), close: vi.fn() }));
vi.mock('@/lib/auth/email', () => ({
  authEmailTransport: () => ({ sendMail: mail.send, close: mail.close }),
  sendAuthEmail: vi.fn(),
}));

import { POST as unsubscribeRoute } from '@/app/api/public/store/[handle]/unsubscribe/route';
import { previewAudience, createSegment } from '@/lib/audience/segments';
import { AudienceFilterError } from '@/lib/audience/filter';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { recordOfflinePayment } from '@/lib/payments/offline';
import { saveBuyerSettings } from './buyer-settings';
import { placeOrder } from './checkout';
import {
  cancelCampaign, createCampaign, getCampaign, listCampaigns, previewCampaignAudience, recordEmailConsent, sendCampaign, updateCampaign,
} from './email-campaigns';
import { handleEmailSendJob, handleOrderEmailJob, queueOrderEmailTx, unsubscribeByToken } from './email-jobs';
import { campaignJobKey, orderEmailJobKey, parseCampaignInput, parseMarketingSettings, referralJobKey } from './email-rules';
import { unsubscribeToken } from './email-send';
import { getLinkPage, loadPublicLinkPage, saveLinkPage } from './link-page';
import { parseLinkPage } from './link-page-rules';
import { getMarketingSettings, saveMarketingSettings } from './marketing-settings';
import { minorToDecimalString } from './money';
import { createCartCode } from './public-shop';
import { createAffiliate, handleReferralRewardJob, listReferralCodes, parseAffiliate, updateReferralCode } from './referrals';
import { issueSessionTx, loadSession, quoteSessionTx, setAddressTx, setPaymentMethodTx, updateCartTx } from './storefront';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
const authUrl = process.env.TEST_AUTH_DATABASE_URL || configured?.AUTH_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
if (authUrl) process.env.AUTH_DATABASE_URL = authUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
const ORIGIN = new URL(process.env.APP_URL).origin;

type Staff = TenantContext & { userId: string };
const account = randomUUID(), other = randomUUID(), bulk = randomUUID();
const owner = randomUUID(), admin = randomUUID(), agent = randomUUID(), viewer = randomUUID();
const asAdmin: Staff = { accountId: account, userId: admin, role: 'admin' };
const asAgent: Staff = { accountId: account, userId: agent, role: 'agent' };
const asViewer: Staff = { accountId: account, userId: viewer, role: 'viewer' };
const asOwner: Staff = { accountId: account, userId: owner, role: 'owner' };
const otherAdmin: Staff = { accountId: other, userId: owner, role: 'admin' };
const bulkAdmin: Staff = { accountId: bulk, userId: owner, role: 'admin' };

const names = ['asha', 'ravi', 'noEmail', 'badEmail', 'unsub', 'blocked', 's1', 's2', 's3', 's4', 'buyer3', 'buyer4', 'buyer5'] as const;
type Name = (typeof names)[number];
const contacts = Object.fromEntries(names.map((n) => [n, randomUUID()])) as Record<Name, string>;
const emails: Partial<Record<Name, string>> = {
  asha: 'asha@example.com', ravi: 'ravi@example.com', badEmail: 'not-an-email', unsub: 'unsub@example.com', blocked: 'blocked@example.com', s1: 's1@example.com', s2: 's2@example.com',
  buyer3: 'buyer3@example.com', buyer4: 'buyer4@example.com', buyer5: 'buyer5@example.com',
};
const otherContacts = Array.from({ length: 3 }, () => randomUUID());
const ids = Object.fromEntries(['cat', 'p1', 'p2', 'p3', 'v1', 'v2', 'v3', 'foreignProduct', 'foreignVariant', 'foreignCat', 'config'].map((n) => [n, randomUUID()])) as Record<string, string>;
const handle = `p8b6-${account.slice(0, 8)}`;
let db: pg.Client;
let ip = 0;

const worker = <T,>(fn: (tx: TenantTransaction) => Promise<T>, ac: string = account) => withTenant({ accountId: ac, role: 'owner' }, fn, getWorkerPrisma());
const one = async <T,>(sql: string, values: unknown[] = []): Promise<T> => (await db.query(sql, values)).rows[0] as T;
const rows = async <T,>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.query(sql, values)).rows as T[];
const smtp = (on: boolean) => { if (on) { process.env.SMTP_URL = 'smtps://test.invalid'; process.env.AUTH_EMAIL_FROM = 'Platform <noreply@example.test>'; } else { delete process.env.SMTP_URL; delete process.env.AUTH_EMAIL_FROM; } };

async function pricedOrder(id: string, contactId: string, over: { at: string; total: number; status?: string; paid?: boolean; refunded?: number; ac?: string }) {
  await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,total_minor,tax_inclusive,status,priced_at,paid_at,amount_paid_minor,amount_refunded_minor,payment_method,created_at)
    VALUES($1,$2,'storefront',$3,'INR',$4::bigint,$4::bigint,true,$5,$6::timestamptz,CASE WHEN $7::boolean THEN $6::timestamptz END,CASE WHEN $7::boolean THEN $4::bigint ELSE 0 END,$8::bigint,'online',$6::timestamptz)`,
  [id, over.ac ?? account, contactId, over.total, over.status ?? 'paid', over.at, over.paid ?? true, over.refunded ?? 0]);
}
const line = (orderId: string, variantId: string, gift = false, ac = account) => db.query(
  `INSERT INTO order_items(account_id,order_id,variant_id,sku,name,quantity,unit_price_minor,currency,line_total_minor,is_gift) VALUES($1,$2,$3,'SKU','Thing',1,1000,'INR',$4,$5)`,
  [ac, orderId, variantId, gift ? 0 : 1000, gift]);

// ------------------------------------------------------------------ real checkout helpers
const ADDRESS = { name: 'Buyer', phone: '+919876543210', line1: '1 MG Road', city: 'Bengaluru', postal_code: '560001', country: 'IN' };
async function shop(contactId: string, cartCode?: { referralCodeId: string }) {
  const sessionId = randomUUID();
  await worker((tx) => issueSessionTx(tx, account, { sessionId, contactId, conversationId: null, whatsappConfigId: null, purpose: 'shop', orderId: null, ttlHours: 24, createdBy: null }));
  if (cartCode) await db.query(`INSERT INTO shop_cart_codes(account_id,code,cart,expires_at,claimed_at,contact_id,session_id,referral_code_id)
    VALUES($1,$2,$3::jsonb,now() + interval '1 hour',now(),$4,$5,$6)`, [account, randomCode(), JSON.stringify([{ variantId: ids.v1, qty: 1 }]), contactId, sessionId, cartCode.referralCodeId]);
  const version = async () => (await worker((tx) => loadSession(tx, account, sessionId)))!.version;
  await worker((tx) => updateCartTx(tx, account, sessionId, { expectedVersion: 1, lines: [{ variantId: ids.v1, qty: 1 }] }));
  await worker((tx) => setAddressTx(tx, account, sessionId, { expectedVersion: 2, address: ADDRESS }));
  const v = await version();
  await worker((tx) => setPaymentMethodTx(tx, account, sessionId, { expectedVersion: v, paymentMethod: 'cod' }));
  const result = await worker(async (tx) => (await quoteSessionTx(tx, account, (await loadSession(tx, account, sessionId))!)).result);
  if (!result.ok) throw new Error(`quote refused: ${result.code}`);
  return { sessionId, version: await version(), total: result.quote.totalMinor };
}
const randomCode = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
const place = (s: { sessionId: string; version: number; total: number }) => placeOrder(account, s.sessionId, { expectedVersion: s.version, expectedTotalMinor: s.total, clientRequestId: randomUUID() });
const pay = (orderId: string, total: number) => recordOfflinePayment(asOwner, orderId, { amount: minorToDecimalString(total, 'INR'), method: 'cash', clientRequestId: randomUUID() });
const credit = async (contactId: string) => Number((await one<{ b: string }>('SELECT COALESCE(sum(amount_minor),0) AS b FROM shop_credit_ledger WHERE contact_id=$1', [contactId])).b);
const codeOf = async (contactId: string) => (await one<{ id: string; code: string }>(`SELECT id::text AS id, code FROM shop_referral_codes WHERE contact_id=$1`, [contactId]));
const referralOf = (orderId: string) => one<{ status: string; reason: string | null; kind: string; net_minor: string | null; reward_minor: string | null; commission_minor: string | null; referrer_contact_id: string | null }>(
  'SELECT * FROM shop_referrals WHERE order_id=$1', [orderId]);

const unsubscribeRequest = (token: unknown, over: { origin?: string | null; path?: string } = {}) => unsubscribeRoute(
  new Request(`${ORIGIN}/api/public/store/${handle}/unsubscribe`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(over.origin === null ? {} : { origin: over.origin ?? ORIGIN }), 'x-forwarded-for': `203.0.113.${(ip++ % 200) + 1}` },
    body: JSON.stringify({ token }),
  }), { params: Promise.resolve({ handle: over.path ?? handle }) });

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('store phase 8 batch 6: shop marketing on PostgreSQL', { timeout: 240_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P8B6', 'test-only-hash' FROM unnest($1::uuid[]) x", [[owner, admin, agent, viewer]]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P8B6 shop',$4),($2,'P8B6 other',$4),($3,'P8B6 bulk',$4)", [account, other, bulk, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic'),($3,'basic')", [account, other, bulk]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($1,$5,'viewer'),($6,$2,'owner'),($7,$2,'owner')", [account, owner, admin, agent, viewer, other, bulk]);
    await db.query(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,access_token,status,is_default) VALUES($1,$2,$3,$4,'test-token','connected',true)`, [ids.config, account, owner, `pn-${account}`]);
    for (const n of names) await db.query('INSERT INTO contacts(id,account_id,user_id,name,phone,email,blocked_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [contacts[n], account, owner, `Customer ${n}`, `+1415${String(Math.abs(n.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 10_000_000).padStart(7, '0')}`, emails[n] ?? null, n === 'blocked' ? new Date('2026-01-01') : null]);
    for (const [i, c] of otherContacts.entries()) await db.query('INSERT INTO contacts(id,account_id,user_id,name,phone,email) VALUES($1,$2,$3,$4,$5,$6)', [c, other, owner, `Other ${i}`, `+1416000000${i}`, `other${i}@example.com`]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,cod_enabled,cod_fee_minor) VALUES($1,'INR',false,500,true,true,0),($2,'INR',false,500,true,false,0)`, [account, other]);
    await db.query(`INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc) VALUES($1,'razorpay','test','rzp_test_P8B6','enc')`, [account]);
    await db.query(`INSERT INTO shipping_rates(account_id,name,country,fee_minor,tax_rate_bps) VALUES($1,'India','IN',6000,0)`, [account]);
    await db.query(`INSERT INTO shop_categories(id,account_id,name) VALUES($1,$3,'Herbs'),($2,$4,'Other herbs')`, [ids.cat, ids.foreignCat, account, other]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at,category_id) VALUES($1,$4,'Triphala','published',now(),$5),($2,$4,'Soap','published',now(),NULL),($3,$4,'Hidden draft','draft',NULL,NULL)`,
      [ids.p1, ids.p2, ids.p3, account, ids.cat]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Foreign','published',now())`, [ids.foreignProduct, other]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory) VALUES($1,$4,$5,'TRI-1',20000,false),($2,$4,$6,'SOAP-1',5000,false),($3,$4,$7,'HID-1',1000,false)`,
      [ids.v1, ids.v2, ids.v3, account, ids.p1, ids.p2, ids.p3]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory) VALUES($1,$2,$3,'FOR-1',100,false)`, [ids.foreignVariant, other, ids.foreignProduct]);
    await db.query(`INSERT INTO shop_storefronts(account_id,handle,published,template,whatsapp_config_id,whatsapp_phone) VALUES($1,$2,true,'wellness',$3,'919800000000')`, [account, handle, ids.config]);

    // Shop history for the segment filters. s1: three paid orders (one part refunded); s2: one paid order with a free gift; s3: a cancelled and an unpaid one; s4: none.
    const o = Object.fromEntries(['o1', 'o2', 'o3', 'o4', 'o5', 'o6'].map((k) => [k, randomUUID()]));
    await pricedOrder(o.o1, contacts.s1, { at: '2026-01-10T10:00:00Z', total: 100_000 });
    await pricedOrder(o.o2, contacts.s1, { at: '2026-03-10T10:00:00Z', total: 50_000, refunded: 20_000 });
    await pricedOrder(o.o3, contacts.s1, { at: '2026-05-10T10:00:00Z', total: 20_000 });
    await pricedOrder(o.o4, contacts.s2, { at: '2026-02-01T10:00:00Z', total: 40_000 });
    await pricedOrder(o.o5, contacts.s3, { at: '2026-02-01T10:00:00Z', total: 40_000, status: 'cancelled' });
    await pricedOrder(o.o6, contacts.s3, { at: '2026-02-02T10:00:00Z', total: 40_000, status: 'awaiting_payment', paid: false });
    await line(o.o1, ids.v1); await line(o.o3, ids.v2); await line(o.o4, ids.v2); await line(o.o4, ids.v1, true);
    // Another workspace with a heavy buyer: it must never count here.
    const foreign = randomUUID();
    await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,total_minor,tax_inclusive,status,priced_at,paid_at,amount_paid_minor) SELECT gen_random_uuid(),$1,'storefront',$2,'INR',100,100,true,'paid',now(),now(),100 FROM generate_series(1,5)`, [other, otherContacts[0]]);
    await pricedOrder(foreign, otherContacts[0], { at: '2026-04-01T10:00:00Z', total: 100, ac: other });
    await line(foreign, ids.foreignVariant, false, other);

    // The bulk workspace: many consenting contacts, to see the send rate.
    await db.query(`INSERT INTO contacts(account_id,user_id,name,phone,email) SELECT $1,$2,'Bulk '||n,'+1417'||lpad(n::text,7,'0'),'bulk'||n||'@example.com' FROM generate_series(1,65) n`, [bulk, owner]);
    await db.query(`INSERT INTO shop_email_prefs(account_id,contact_id,opted_in_at,opt_in_source) SELECT account_id,id,now(),'staff_attestation' FROM contacts WHERE account_id=$1`, [bulk]);
  });

  beforeEach(() => {
    mail.send.mockReset().mockResolvedValue({ accepted: ['x'] });
    mail.close.mockReset();
    smtp(true);
  });

  afterAll(async () => {
    smtp(true);
    if (db) {
      await db.query('DELETE FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[account, other, bulk]]);
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[account, other, bulk]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[account, other, bulk]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[owner, admin, agent, viewer]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  // ------------------------------------------------------------------ segments
  it('counts shop customers by orders, spend, dates and purchases inside the workspace only', async () => {
    const total = (await one<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE account_id=$1', [account])).n;
    const count = async (ctx: Staff, ...conditions: unknown[]) => (await previewAudience(ctx, { filter: { conditions } })).total;
    expect(await count(asAdmin, { field: 'shop_orders', op: 'at_least', value: 1 })).toBe(2);
    expect(await count(asAdmin, { field: 'shop_orders', op: 'at_least', value: 3 })).toBe(1);
    // Cancelled and unpaid orders are not counted: s3 has none, like a customer who never ordered.
    expect(await count(asAdmin, { field: 'shop_orders', op: 'at_most', value: 0 })).toBe(total - 2);
    // Spend is net of refunds: 100000 + (50000 - 20000) + 20000.
    expect(await count(asAdmin, { field: 'shop_spend', op: 'at_least', value: 150_000 })).toBe(1);
    expect(await count(asAdmin, { field: 'shop_spend', op: 'at_least', value: 150_001 })).toBe(0);
    expect(await count(asAdmin, { field: 'shop_spend', op: 'at_least', value: 40_000 }, { field: 'shop_spend', op: 'at_most', value: 40_000 })).toBe(1);
    expect(await count(asAdmin, { field: 'shop_order_date', which: 'last', op: 'before', value: '2026-04-01' })).toBe(1);
    expect(await count(asAdmin, { field: 'shop_order_date', which: 'last', op: 'after', value: '2026-04-01' })).toBe(1);
    expect(await count(asAdmin, { field: 'shop_order_date', which: 'first', op: 'before', value: '2026-02-01' })).toBe(1);
    expect(await count(asAdmin, { field: 'shop_order_date', which: 'first', op: 'after', value: '2026-01-31' })).toBe(1);
    // A free gift is not a purchase: s2 got the product free, s1 bought it.
    expect(await count(asAdmin, { field: 'shop_bought', op: 'bought', productId: ids.p1 })).toBe(1);
    expect(await count(asAdmin, { field: 'shop_bought', op: 'bought', productId: ids.p2 })).toBe(2);
    expect(await count(asAdmin, { field: 'shop_bought', op: 'bought', categoryId: ids.cat })).toBe(1);
    expect(await count(asAdmin, { field: 'shop_bought', op: 'not_bought', productId: ids.p1 })).toBe(total - 1);
    // Combined with an ordinary field.
    expect(await count(asAdmin, { field: 'shop_orders', op: 'at_least', value: 1 }, { field: 'email', op: 'contains', value: 's2@' })).toBe(1);
    // Another workspace's heavy buyer counts only there.
    expect(await count(otherAdmin, { field: 'shop_orders', op: 'at_least', value: 3 })).toBe(1);
    expect(await count(asAdmin, { field: 'shop_orders', op: 'at_least', value: 5 })).toBe(0);
    // A product or category of another workspace cannot be named.
    await expect(createSegment(asAdmin, { name: 'Foreign product', filter: { conditions: [{ field: 'shop_bought', op: 'bought', productId: ids.foreignProduct }] } })).rejects.toBeInstanceOf(AudienceFilterError);
    await expect(createSegment(asAdmin, { name: 'Foreign category', filter: { conditions: [{ field: 'shop_bought', op: 'bought', categoryId: ids.foreignCat }] } })).rejects.toBeInstanceOf(AudienceFilterError);
    const saved = await createSegment(asAdmin, { name: 'Bought something', filter: { conditions: [{ field: 'shop_orders', op: 'at_least', value: 1 }] } });
    expect(saved.filter.conditions).toHaveLength(1);
  });

  // ------------------------------------------------------------------ roles
  it('keeps campaigns, consent, settings, affiliates and the link page admin-only, and readable by agents', async () => {
    const campaign = parseCampaignInput({ name: 'Roles', subject: 'Hello', body: 'Body', segment_id: null });
    for (const who of [asAgent, asViewer]) {
      await expect(createCampaign(who, campaign)).rejects.toThrow();
      await expect(recordEmailConsent(who, null)).rejects.toThrow();
      await expect(saveMarketingSettings(who, parseMarketingSettings({ order_emails_enabled: true, sender_name: null, sender_address: 'x', reply_to: null, referral_enabled: false, referral_reward_minor: 0, referral_hold_days: 14 }))).rejects.toThrow();
      await expect(createAffiliate(who, parseAffiliate({ name: 'Priya', commission_bps: 500 }))).rejects.toThrow();
      await expect(saveLinkPage(who, parseLinkPage({ enabled: true, bio: null, links: [], featured_product_ids: [] }))).rejects.toThrow();
    }
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM shop_email_campaigns WHERE account_id=$1', [account])).n).toBe(0);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM shop_email_prefs WHERE account_id=$1', [account])).n).toBe(0);
    // Reading is for agents and above.
    expect(await listCampaigns(asAgent)).toEqual([]);
    expect(await getMarketingSettings(asAgent)).toMatchObject({ order_emails_enabled: false, referral_enabled: false, email_connected: true });
    expect((await listReferralCodes(asAgent)).codes).toEqual([]);
    expect(await getLinkPage(asAgent)).toMatchObject({ enabled: false, links: [] });
    // The tables hold the same line when written to directly as the app role: an admin can never record an unsubscribe.
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`INSERT INTO shop_email_prefs(account_id,contact_id,unsubscribed_at) VALUES(${account}::uuid,${contacts.asha}::uuid,now())`)).rejects.toThrow();
    await expect(withTenant(asAgent, (tx) => tx.$executeRaw`INSERT INTO shop_referrals(account_id,order_id,kind,buyer_contact_id) VALUES(${account}::uuid,${randomUUID()}::uuid,'affiliate',${contacts.asha}::uuid)`)).rejects.toThrow();
  });

  // ------------------------------------------------------------------ campaigns
  const campaigns: Record<string, string> = {};
  let foreignCode = '';

  it('refuses to send without SMTP, the postal address, consent or an audience, and creates nothing when it refuses', async () => {
    const draft = await createCampaign(asAdmin, parseCampaignInput({ name: 'Festive', subject: 'Festive offers', body: 'Hello from the shop.', segment_id: null }));
    campaigns.all = draft.id;
    expect(draft).toMatchObject({ status: 'draft', recipient_count: 0, segment_name: null });
    smtp(false);
    await expect(sendCampaign(asAdmin, draft.id)).rejects.toMatchObject({ code: 'email_not_connected' });
    expect(await getMarketingSettings(asAdmin)).toMatchObject({ email_connected: false });
    smtp(true);
    await expect(sendCampaign(asAdmin, draft.id)).rejects.toMatchObject({ code: 'sender_details_required' });
    await saveMarketingSettings(asAdmin, parseMarketingSettings({ order_emails_enabled: false, sender_name: 'Asha Shop', sender_address: '12 Lake Road, Bengaluru 560001', reply_to: 'help@example.com', referral_enabled: false, referral_reward_minor: 0, referral_hold_days: 14 }));
    // Nobody has consented yet.
    await expect(sendCampaign(asAdmin, draft.id)).rejects.toMatchObject({ code: 'no_recipients' });
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM shop_email_recipients WHERE campaign_id=$1', [draft.id])).n).toBe(0);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND type='shop.email_send'`, [account])).n).toBe(0);
    expect(await getCampaign(asAdmin, draft.id)).toMatchObject({ status: 'draft', queued_at: null });
  });

  it('records consent only for customers with a usable address who have not unsubscribed, and never revives an unsubscribe', async () => {
    // One customer unsubscribed before anyone was asked.
    await db.query(`INSERT INTO shop_email_prefs(account_id,contact_id,unsubscribed_at) VALUES($1,$2,now())`, [account, contacts.unsub]);
    const before = await previewCampaignAudience(asAdmin, null);
    expect(before.eligible).toBe(0);
    expect(before.unsubscribed).toBe(1);
    // Emailable and not blocked: asha, ravi, s1, s2, buyer3, buyer4, buyer5 (not the bad address, the blocked one, the unsubscribed one, or those with no email).
    expect(await recordEmailConsent(asAdmin, null)).toEqual({ recorded: 7 });
    expect(await recordEmailConsent(asAdmin, null)).toEqual({ recorded: 0 });
    const prefs = await rows<{ contact_id: string; opted_in_at: Date | null; opt_in_source: string | null; opted_in_by: string | null }>('SELECT * FROM shop_email_prefs WHERE account_id=$1', [account]);
    expect(prefs.filter((p) => p.opted_in_at).map((p) => p.contact_id).sort()).toEqual([contacts.asha, contacts.ravi, contacts.s1, contacts.s2, contacts.buyer3, contacts.buyer4, contacts.buyer5].sort());
    expect(prefs.find((p) => p.contact_id === contacts.asha)).toMatchObject({ opt_in_source: 'staff_attestation', opted_in_by: admin });
    expect(prefs.find((p) => p.contact_id === contacts.unsub)?.opted_in_at).toBeNull();
    // Not even a direct write by an admin can give an unsubscribed customer consent back.
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE shop_email_prefs SET opted_in_at=now() WHERE account_id=${account}::uuid AND contact_id=${contacts.unsub}::uuid`)).rejects.toThrow();
    expect((await previewCampaignAudience(asAdmin, null)).eligible).toBe(7);
    // The segment audience narrows it: customers who bought something.
    const segment = (await db.query('SELECT id FROM segments WHERE account_id=$1', [account])).rows[0].id as string;
    expect(await previewCampaignAudience(asAdmin, segment)).toMatchObject({ audience: 2, withEmail: 2, eligible: 2 });
    // Another workspace sees none of this.
    expect(await previewCampaignAudience(otherAdmin, null)).toMatchObject({ audience: 3, eligible: 0 });
  });

  it('queues one job per eligible recipient before it answers, freezes the text, and queues only what is missing when sent again', async () => {
    const sent = await sendCampaign(asAdmin, campaigns.all);
    expect(sent).toMatchObject({ status: 'sending', recipient_count: 7 });
    expect(sent.queued_at).not.toBeNull();
    expect(sent.counts).toMatchObject({ queued: 7, sent: 0 });
    const jobs = await rows<{ dedupe_key: string; payload: { campaignId: string; contactId: string } }>(`SELECT dedupe_key, payload FROM jobs WHERE tenant_id=$1 AND type='shop.email_send'`, [account]);
    expect(jobs).toHaveLength(7);
    expect(jobs.map((j) => j.dedupe_key).sort()).toEqual([contacts.asha, contacts.ravi, contacts.s1, contacts.s2, contacts.buyer3, contacts.buyer4, contacts.buyer5].map((c) => campaignJobKey(campaigns.all, c)).sort());
    // The recipient list is a snapshot of lower-cased addresses of exactly the consenting contacts.
    const recipients = await rows<{ contact_id: string; email: string; status: string }>('SELECT contact_id, email, status FROM shop_email_recipients WHERE campaign_id=$1', [campaigns.all]);
    expect(recipients).toHaveLength(7);
    expect(recipients.find((r) => r.contact_id === contacts.asha)?.email).toBe('asha@example.com');
    expect(recipients.some((r) => [contacts.unsub, contacts.blocked, contacts.noEmail, contacts.badEmail].includes(r.contact_id))).toBe(false);
    // Sending again changes nothing; a lost job is queued again by the same key, without a second recipient.
    await db.query(`DELETE FROM jobs WHERE dedupe_key=$1`, [campaignJobKey(campaigns.all, contacts.buyer5)]);
    await sendCampaign(asAdmin, campaigns.all);
    await sendCampaign(asAdmin, campaigns.all);
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND type='shop.email_send'`, [account])).n).toBe(7);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM shop_email_recipients WHERE campaign_id=$1', [campaigns.all])).n).toBe(7);
    // What was queued cannot be rewritten, by the app or by the table.
    await expect(updateCampaign(asAdmin, campaigns.all, parseCampaignInput({ name: 'Festive', subject: 'Changed', body: 'Changed', segment_id: null }))).rejects.toMatchObject({ code: 'campaign_locked' });
    await expect(db.query(`UPDATE shop_email_campaigns SET body='Changed' WHERE id=$1`, [campaigns.all])).rejects.toThrow(/campaign_locked/);
    // Another workspace cannot see, send, or cancel it.
    await expect(getCampaign(otherAdmin, campaigns.all)).rejects.toMatchObject({ code: 'not_found' });
    await expect(sendCampaign(otherAdmin, campaigns.all)).rejects.toMatchObject({ code: 'not_found' });
    await expect(cancelCampaign(otherAdmin, campaigns.all)).rejects.toMatchObject({ code: 'not_found' });
    expect(await listCampaigns(otherAdmin)).toEqual([]);
    expect(await handleEmailSendJob(other, { campaignId: campaigns.all, contactId: contacts.asha })).toBe('done');
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('sends each recipient once, with the unsubscribe link and postal address, and honours an unsubscribe made after queuing', async () => {
    // ravi unsubscribes from the link in an earlier email, after this campaign was queued.
    expect(await unsubscribeByToken(unsubscribeToken(account, contacts.ravi))).toBe(true);
    expect(await unsubscribeByToken(unsubscribeToken(account, contacts.ravi))).toBe(true);
    expect(await unsubscribeByToken('nonsense')).toBe(false);
    expect(await unsubscribeByToken(unsubscribeToken(account, randomUUID()))).toBe(true);
    const run = (who: Name, campaign = campaigns.all) => handleEmailSendJob(account, { campaignId: campaign, contactId: contacts[who] });
    expect(await run('asha')).toBe('sent');
    expect(await run('ravi')).toBe('skipped');
    expect(mail.send).toHaveBeenCalledTimes(1);
    const sent = mail.send.mock.calls[0][0] as { from: { name: string; address: string }; to: string; subject: string; text: string; replyTo: string; headers: Record<string, string> };
    expect(sent).toMatchObject({ from: { name: 'Asha Shop', address: 'noreply@example.test' }, to: 'asha@example.com', subject: 'Festive offers', replyTo: 'help@example.com' });
    expect(sent.text).toContain('Hello from the shop.');
    expect(sent.text).toContain('12 Lake Road, Bengaluru 560001');
    const link = /https:\/\/[^\s]+\/unsubscribe\/[^\s?]+\?t=[^\s]+/.exec(sent.text)?.[0];
    expect(link).toBeTruthy();
    expect(sent.headers['List-Unsubscribe']).toBe(`<${link}>`);
    expect(link).toContain(`/unsubscribe/${handle}?t=${unsubscribeToken(account, contacts.asha)}`);
    const status = async (who: Name, campaign = campaigns.all) => one<{ status: string; reason: string | null }>('SELECT status, reason FROM shop_email_recipients WHERE campaign_id=$1 AND contact_id=$2', [campaign, contacts[who]]);
    expect(await status('asha')).toMatchObject({ status: 'sent', reason: null });
    expect(await status('ravi')).toMatchObject({ status: 'skipped', reason: 'unsubscribed' });
    // Consent cannot be recorded for them again, so a later campaign leaves them out as well.
    expect(await recordEmailConsent(asAdmin, null)).toEqual({ recorded: 0 });
    expect((await previewCampaignAudience(asAdmin, null)).eligible).toBe(6);

    // The same job again, and again after the row was set back as if the process died: nothing is sent twice.
    expect(await run('asha')).toBe('done');
    await db.query(`UPDATE shop_email_recipients SET status='queued', settled_at=NULL WHERE campaign_id=$1 AND contact_id=$2`, [campaigns.all, contacts.asha]);
    // The earlier attempt's send was accepted: the answer is that one, not a second email.
    expect(await run('asha')).toBe('sent');
    expect(mail.send).toHaveBeenCalledTimes(1);

    // An answer that never came back: shown as unknown, never sent again, even when the server works afterwards.
    mail.send.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ESOCKET' }));
    expect(await run('s1')).toBe('unknown');
    expect(await status('s1')).toMatchObject({ status: 'unknown', reason: 'outcome_unknown' });
    expect(mail.send).toHaveBeenCalledTimes(2);
    await db.query(`UPDATE shop_email_recipients SET status='queued', settled_at=NULL WHERE campaign_id=$1 AND contact_id=$2`, [campaigns.all, contacts.s1]);
    expect(await run('s1')).toBe('unknown');
    expect(await run('s1')).toBe('done');
    expect(mail.send).toHaveBeenCalledTimes(2);
    expect(await getCampaign(asAdmin, campaigns.all)).toMatchObject({ counts: { sent: 1, skipped: 1, unknown: 1, queued: 4 } });
    // Logs never carry an address: the failure above logged nothing with one.
  });

  it('sends nothing while SMTP is missing, skips a stopped campaign, and spreads a large campaign over time', async () => {
    // A campaign to the "bought something" segment, queued while email works and run after SMTP went away.
    const segment = (await db.query('SELECT id FROM segments WHERE account_id=$1', [account])).rows[0].id as string;
    const draft = await createCampaign(asAdmin, parseCampaignInput({ name: 'Buyers', subject: 'Thanks', body: 'Thank you.', segment_id: segment }));
    expect(draft.segment_name).toBe('Bought something');
    expect((await sendCampaign(asAdmin, draft.id)).recipient_count).toBe(2);
    smtp(false);
    expect(await handleEmailSendJob(account, { campaignId: draft.id, contactId: contacts.s1 })).toBe('skipped');
    expect(mail.send).not.toHaveBeenCalled();
    expect(await one<{ status: string; reason: string }>('SELECT status, reason FROM shop_email_recipients WHERE campaign_id=$1 AND contact_id=$2', [draft.id, contacts.s1])).toMatchObject({ status: 'skipped', reason: 'email_not_connected' });
    smtp(true);

    // Stopped: waiting recipients are skipped and their jobs do nothing.
    const stopped = await createCampaign(asAdmin, parseCampaignInput({ name: 'Stop me', subject: 'Stop', body: 'Stop.', segment_id: null }));
    await sendCampaign(asAdmin, stopped.id);
    const after = await cancelCampaign(asAdmin, stopped.id);
    expect(after.status).toBe('cancelled');
    expect(after.counts).toMatchObject({ queued: 0, skipped: 6 });
    expect(await handleEmailSendJob(account, { campaignId: stopped.id, contactId: contacts.s2 })).toBe('done');
    await expect(sendCampaign(asAdmin, stopped.id)).rejects.toMatchObject({ code: 'campaign_locked' });
    expect(mail.send).not.toHaveBeenCalled();

    // 65 recipients go out 30 a minute: three one-minute slots.
    const big = await createCampaign(bulkAdmin, parseCampaignInput({ name: 'Bulk', subject: 'Bulk', body: 'Bulk.', segment_id: null }));
    await saveMarketingSettings(bulkAdmin, parseMarketingSettings({ order_emails_enabled: false, sender_name: null, sender_address: '1 Road', reply_to: null, referral_enabled: false, referral_reward_minor: 0, referral_hold_days: 14 }));
    expect((await sendCampaign(bulkAdmin, big.id)).recipient_count).toBe(65);
    const spread = await one<{ slots: number; span: number }>(`SELECT count(DISTINCT run_at)::int AS slots, EXTRACT(EPOCH FROM max(run_at) - min(run_at))::int AS span FROM jobs WHERE tenant_id=$1 AND type='shop.email_send'`, [bulk]);
    expect(spread).toEqual({ slots: 3, span: 120 });
  });

  it('records an unsubscribe from the public page: only the signed token works, from our own origin', async () => {
    const token = unsubscribeToken(account, contacts.buyer3);
    expect((await unsubscribeRequest(token, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await unsubscribeRequest(token, { origin: null })).status).toBe(403);
    expect((await unsubscribeRequest('x'.repeat(50))).status).toBe(400);
    expect((await unsubscribeRequest(token.replace(contacts.buyer3, contacts.buyer4))).status).toBe(400);
    expect((await unsubscribeRequest(undefined)).status).toBe(400);
    expect((await unsubscribeRequest(token, { path: 'Bad Handle!' })).status).toBe(404);
    expect((await db.query('SELECT 1 FROM shop_email_prefs WHERE contact_id=$1 AND unsubscribed_at IS NOT NULL', [contacts.buyer3])).rowCount).toBe(0);
    const ok = await unsubscribeRequest(token);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect((await unsubscribeRequest(token)).status).toBe(200);
    expect((await db.query('SELECT 1 FROM shop_email_prefs WHERE contact_id=$1 AND unsubscribed_at IS NOT NULL AND opted_in_at IS NOT NULL', [contacts.buyer3])).rowCount).toBe(1);
    expect(await handleEmailSendJob(account, { campaignId: campaigns.all, contactId: contacts.buyer3 })).toBe('skipped');
    expect(mail.send).not.toHaveBeenCalled();
    // The token names its own workspace: nothing was written in another.
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM shop_email_prefs WHERE account_id=$1', [other])).n).toBe(0);
  });

  // ------------------------------------------------------------------ order confirmation, referrals
  it('sends one confirmation email per order, only when switched on and the buyer has an address', async () => {
    const settings = { order_emails_enabled: false, sender_name: 'Asha Shop', sender_address: '12 Lake Road, Bengaluru 560001', reply_to: null, referral_enabled: true, referral_reward_minor: 5_000, referral_hold_days: 14 };
    await saveMarketingSettings(asAdmin, parseMarketingSettings(settings));
    const off = await place(await shop(contacts.buyer5));
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE type='shop.order_email' AND dedupe_key=$1`, [orderEmailJobKey(off.orderId)])).n).toBe(0);
    await saveMarketingSettings(asAdmin, parseMarketingSettings({ ...settings, order_emails_enabled: true }));
    // No address on the contact: nothing is queued.
    const noAddress = await place(await shop(contacts.s3));
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE type='shop.order_email' AND dedupe_key=$1`, [orderEmailJobKey(noAddress.orderId)])).n).toBe(0);
    const s = await shop(contacts.asha);
    const first = await place(s);
    expect((await place(s)).orderId).toBe(first.orderId);
    const queued = await rows<{ dedupe_key: string; payload: { orderId: string } }>(`SELECT dedupe_key, payload FROM jobs WHERE type='shop.order_email' AND tenant_id=$1`, [account]);
    expect(queued).toEqual([{ dedupe_key: orderEmailJobKey(first.orderId), payload: { orderId: first.orderId } }]);
    // Queuing it again, and the worker running it twice, still sends one email.
    await worker((tx) => queueOrderEmailTx(tx, account, first.orderId));
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE type='shop.order_email' AND tenant_id=$1`, [account])).n).toBe(1);
    expect(await handleOrderEmailJob(account, { orderId: first.orderId })).toBe('sent');
    expect(await handleOrderEmailJob(account, { orderId: first.orderId })).toBe('done');
    expect(mail.send).toHaveBeenCalledTimes(1);
    const sent = mail.send.mock.calls[0][0] as { to: string; subject: string; text: string };
    expect(sent.to).toBe('asha@example.com');
    expect(sent.subject).toContain(first.orderId.replace(/-/g, '').slice(0, 8).toUpperCase());
    expect(sent.text).toContain('Triphala');
    expect(sent.text).not.toContain('unsubscribe');
    expect((await one<{ status: string }>('SELECT status FROM shop_order_emails WHERE order_id=$1', [first.orderId])).status).toBe('sent');
    // An answer that never came back is recorded and not sent again; no SMTP sends nothing.
    const ravi = await place(await shop(contacts.ravi));
    mail.send.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await handleOrderEmailJob(account, { orderId: ravi.orderId })).toBe('unknown');
    expect(await handleOrderEmailJob(account, { orderId: ravi.orderId })).toBe('done');
    expect(mail.send).toHaveBeenCalledTimes(2);
    const later = await place(await shop(contacts.buyer4));
    smtp(false);
    expect(await handleOrderEmailJob(account, { orderId: later.orderId })).toBe('skipped');
    expect((await one<{ reason: string }>('SELECT reason FROM shop_order_emails WHERE order_id=$1', [later.orderId])).reason).toBe('email_not_connected');
    expect(mail.send).toHaveBeenCalledTimes(2);
    smtp(true);
    // An order of another workspace is not found from here.
    expect(await handleOrderEmailJob(other, { orderId: first.orderId })).toBe('done');
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM shop_order_emails WHERE account_id=$1', [other])).n).toBe(0);
    expect(mail.send).toHaveBeenCalledTimes(2);
    // Pay the first order: it earns its buyer a referral code, and there is no referral to reward.
    await pay(first.orderId, s.total);
    expect(await codeOf(contacts.asha)).toMatchObject({ code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{8}$/) });
    expect(await referralOf(first.orderId)).toBeUndefined();
  });

  it('takes an optional checkout email: kept on the order, given to a contact that has none, and consent only when the box is ticked', async () => {
    const withEmail = async (who: Name, extra: { email?: string | null; emailOffers?: boolean }) => {
      const s = await shop(contacts[who]);
      return placeOrder(account, s.sessionId, { expectedVersion: s.version, expectedTotalMinor: s.total, clientRequestId: randomUUID(), ...extra });
    };
    const order = (id: string) => one<{ buyer_email: string | null }>('SELECT buyer_email FROM orders WHERE id=$1', [id]);
    const contact = async (who: Name) => (await one<{ email: string | null }>('SELECT email FROM contacts WHERE id=$1', [contacts[who]])).email;
    const prefs = async (who: Name) => one<{ opted_in_at: Date | null; opt_in_source: string | null; unsubscribed_at: Date | null }>('SELECT opted_in_at, opt_in_source, unsubscribed_at FROM shop_email_prefs WHERE contact_id=$1', [contacts[who]]);

    // Not ticked: the address is kept and used, and no consent is recorded.
    const plain = await withEmail('noEmail', { email: ' New@Example.com ', emailOffers: false });
    expect(await order(plain.orderId)).toEqual({ buyer_email: 'new@example.com' });
    expect(await contact('noEmail')).toBe('new@example.com');
    expect(await prefs('noEmail')).toBeUndefined();
    // No email at all: nothing changes and the order has none.
    const none = await withEmail('s3', {});
    expect(await order(none.orderId)).toEqual({ buyer_email: null });
    expect(await prefs('s3')).toBeUndefined();
    // Ticked: consent with the source "checkout" and the time.
    const ticked = await withEmail('s4', { email: 's4@example.com', emailOffers: true });
    expect(await prefs('s4')).toMatchObject({ opt_in_source: 'checkout', unsubscribed_at: null, opted_in_at: expect.any(Date) });
    expect((await previewCampaignAudience(asAdmin, null)).eligible).toBeGreaterThan(0);
    // The confirmation goes to the address typed at checkout.
    expect(await handleOrderEmailJob(account, { orderId: plain.orderId })).toBe('sent');
    expect((mail.send.mock.calls.at(-1)![0] as { to: string }).to).toBe('new@example.com');
    expect(await handleOrderEmailJob(account, { orderId: ticked.orderId })).toBe('sent');
    expect((mail.send.mock.calls.at(-1)![0] as { to: string }).to).toBe('s4@example.com');

    // A customer's own address is never replaced, and the box then records nothing: campaigns go to the contact's address.
    const different = await withEmail('badEmail', { email: 'good@example.com', emailOffers: true });
    expect(await order(different.orderId)).toEqual({ buyer_email: 'good@example.com' });
    expect(await contact('badEmail')).toBe('not-an-email');
    expect(await prefs('badEmail')).toBeUndefined();
    const keep = await withEmail('buyer4', { email: 'someone.else@example.com', emailOffers: true });
    expect(await contact('buyer4')).toBe('buyer4@example.com');
    expect(await prefs('buyer4')).toMatchObject({ opt_in_source: 'staff_attestation' });
    expect((await order(keep.orderId))!.buyer_email).toBe('someone.else@example.com');

    // An unsubscribe always wins: ticking the box again changes nothing, and the campaign job still skips them.
    const before = await prefs('buyer3');
    expect(before!.unsubscribed_at).not.toBeNull();
    await withEmail('buyer3', { email: 'buyer3@example.com', emailOffers: true });
    expect(await prefs('buyer3')).toEqual(before);
    const sentBefore = mail.send.mock.calls.length;
    expect(await handleEmailSendJob(account, { campaignId: campaigns.all, contactId: contacts.buyer3 })).toBe('done');
    expect(mail.send.mock.calls.length).toBe(sentBefore);
    expect((await one<{ reason: string }>('SELECT reason FROM shop_email_recipients WHERE campaign_id=$1 AND contact_id=$2', [campaigns.all, contacts.buyer3])).reason).toBe('unsubscribed');
    // Unticking later revokes nothing: an earlier consent stays until it is unsubscribed (the customer's own link).
    await withEmail('s4', { email: 's4@example.com', emailOffers: false });
    expect(await prefs('s4')).toMatchObject({ opt_in_source: 'checkout', opted_in_at: expect.any(Date) });

    // Bad input is refused before anything is created.
    for (const bad of [{ email: 'not an email' }, { email: 'a@b.com\nBcc: x@y.z' }, { email: null, emailOffers: true }, { emailOffers: true }]) {
      const s = await shop(contacts.noEmail);
      await expect(placeOrder(account, s.sessionId, { expectedVersion: s.version, expectedTotalMinor: s.total, clientRequestId: randomUUID(), ...bad })).rejects.toMatchObject({ code: 'invalid' });
      expect((await one<{ order_id: string | null }>('SELECT order_id FROM storefront_sessions WHERE id=$1', [s.sessionId])).order_id).toBeNull();
    }
  });

  it('attributes an order to a code, never to its own buyer, an inactive code or another workspace\'s, and rewards once after the hold', async () => {
    const asha = await codeOf(contacts.asha);
    // The code travels with the cart: a known code is stored, an unknown or another workspace's is ignored.
    const cart = [{ variantId: ids.v1, qty: 1 }];
    const withCode = await createCartCode(handle, { cart, clientIp: '203.0.113.50', ref: asha.code.toLowerCase() });
    expect((await one<{ referral_code_id: string }>('SELECT referral_code_id::text AS referral_code_id FROM shop_cart_codes WHERE code=$1 AND account_id=$2', [withCode!.code, account])).referral_code_id).toBe(asha.id);
    foreignCode = randomCode() + 'AB';
    await db.query(`INSERT INTO shop_referral_codes(account_id,code,kind,contact_id) VALUES($1,$2,'contact',$3)`, [other, foreignCode, otherContacts[1]]);
    for (const ref of [foreignCode, 'ZZZZZZZZ', 'not a code', null, 42]) {
      const made = await createCartCode(handle, { cart, clientIp: '203.0.113.51', ref });
      expect((await one<{ referral_code_id: string | null }>('SELECT referral_code_id FROM shop_cart_codes WHERE code=$1 AND account_id=$2', [made!.code, account])).referral_code_id).toBeNull();
    }

    // ravi buys through asha's code; asha cannot refer herself.
    const s = await shop(contacts.ravi, { referralCodeId: asha.id });
    const placed = await place(s);
    expect(await referralOf(placed.orderId)).toMatchObject({ status: 'pending', kind: 'contact', referrer_contact_id: contacts.asha });
    const self = await place(await shop(contacts.asha, { referralCodeId: asha.id }));
    expect(await referralOf(self.orderId)).toBeUndefined();
    // Only the buyer's first referred order counts.
    const again = await place(await shop(contacts.ravi, { referralCodeId: asha.id }));
    expect(await referralOf(again.orderId)).toBeUndefined();
    await db.query('UPDATE shop_referral_codes SET active=false WHERE id=$1', [asha.id]);
    const inactive = await place(await shop(contacts.buyer5, { referralCodeId: asha.id }));
    expect(await referralOf(inactive.orderId)).toBeUndefined();
    await db.query('UPDATE shop_referral_codes SET active=true WHERE id=$1', [asha.id]);

    // Nothing is rewarded before the order is paid; once paid, one job waits for the end of the hold.
    expect(await handleReferralRewardJob(account, { orderId: placed.orderId })).toBe('skipped');
    expect(await referralOf(placed.orderId)).toMatchObject({ status: 'skipped', reason: 'not_paid' });
    await db.query(`UPDATE shop_referrals SET status='pending', reason=NULL, settled_at=NULL WHERE order_id=$1`, [placed.orderId]);
    await pay(placed.orderId, s.total);
    const job = await one<{ run_at: Date; dedupe_key: string }>(`SELECT run_at, dedupe_key FROM jobs WHERE tenant_id=$1 AND type='shop.referral_reward' AND payload->>'orderId'=$2`, [account, placed.orderId]);
    expect(job.dedupe_key).toBe(referralJobKey(placed.orderId));
    const paidAt = (await one<{ paid_at: Date }>('SELECT paid_at FROM orders WHERE id=$1', [placed.orderId])).paid_at;
    expect(Math.round((job.run_at.getTime() - paidAt.getTime()) / 86_400_000)).toBe(14);
    const before = await credit(contacts.asha);
    // The job twice, and twice at once: one credit.
    const results = await Promise.all([handleReferralRewardJob(account, { orderId: placed.orderId }), handleReferralRewardJob(account, { orderId: placed.orderId })]);
    expect(results.filter((r) => r === 'rewarded')).toHaveLength(1);
    expect(await handleReferralRewardJob(account, { orderId: placed.orderId })).toBe('none');
    expect(await credit(contacts.asha)).toBe(before + 5_000);
    expect(await one('SELECT kind, amount_minor::int AS amount, order_id::text AS order_id, dedupe_key FROM shop_credit_ledger WHERE dedupe_key=$1', [`referral:${placed.orderId}`])).toEqual({ kind: 'referral', amount: 5_000, order_id: placed.orderId, dedupe_key: `referral:${placed.orderId}` });
    expect(await referralOf(placed.orderId)).toMatchObject({ status: 'rewarded', reward_minor: '5000' });
    expect(Number((await referralOf(placed.orderId))!.net_minor)).toBe(s.total);
    // A second credit with the same key is refused by the table.
    await expect(db.query(`INSERT INTO shop_credit_ledger(account_id,contact_id,amount_minor,currency,kind,dedupe_key) VALUES($1,$2,5000,'INR','referral',$3)`, [account, contacts.asha, `referral:${placed.orderId}`])).rejects.toThrow();
  });

  it('pays nothing for an order that was refunded or cancelled before the hold ended, and waits for the return window', async () => {
    const asha = await codeOf(contacts.asha);
    const refunded = await shop(contacts.s1, { referralCodeId: asha.id });
    const refundedOrder = await place(refunded);
    await pay(refundedOrder.orderId, refunded.total);
    await db.query('UPDATE orders SET amount_refunded_minor=total_minor WHERE id=$1', [refundedOrder.orderId]);
    const before = await credit(contacts.asha);
    expect(await handleReferralRewardJob(account, { orderId: refundedOrder.orderId })).toBe('skipped');
    expect(await referralOf(refundedOrder.orderId)).toMatchObject({ status: 'skipped', reason: 'refunded' });
    expect(await credit(contacts.asha)).toBe(before);

    // Buyer returns are on with a 30-day window: the reward waits at least that long.
    await saveBuyerSettings(asAdmin, { buyer_returns_enabled: true, price_drop_nudges_enabled: false, note_enabled: false, gift_message_enabled: false, delivery_date_enabled: false, lead_days: 1, window_days: 30, slots: [], custom_fields: [] });
    const cancelled = await shop(contacts.s2, { referralCodeId: asha.id });
    const cancelledOrder = await place(cancelled);
    await pay(cancelledOrder.orderId, cancelled.total);
    const run = (await one<{ run_at: Date }>(`SELECT run_at FROM jobs WHERE tenant_id=$1 AND type='shop.referral_reward' AND payload->>'orderId'=$2`, [account, cancelledOrder.orderId])).run_at;
    const paidAt = (await one<{ paid_at: Date }>('SELECT paid_at FROM orders WHERE id=$1', [cancelledOrder.orderId])).paid_at;
    expect(Math.round((run.getTime() - paidAt.getTime()) / 86_400_000)).toBe(30);
    await db.query(`UPDATE orders SET status='cancelled' WHERE id=$1`, [cancelledOrder.orderId]);
    expect(await handleReferralRewardJob(account, { orderId: cancelledOrder.orderId })).toBe('skipped');
    expect(await referralOf(cancelledOrder.orderId)).toMatchObject({ status: 'skipped', reason: 'order_cancelled' });
    expect(await credit(contacts.asha)).toBe(before);
  });

  it('gives a named affiliate a code and a commission report, and no credit', async () => {
    const created = await createAffiliate(asAdmin, parseAffiliate({ name: 'Priya Blog', commission_bps: 1_000 }));
    expect(created.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    const s = await shop(contacts.buyer3, { referralCodeId: (await listReferralCodes(asAdmin)).codes.find((c) => c.code === created.code)!.id });
    const placed = await place(s);
    expect(await referralOf(placed.orderId)).toMatchObject({ status: 'pending', kind: 'affiliate', referrer_contact_id: null });
    await pay(placed.orderId, s.total);
    expect(await handleReferralRewardJob(account, { orderId: placed.orderId })).toBe('rewarded');
    const settled = await referralOf(placed.orderId);
    expect(Number(settled!.commission_minor)).toBe(Math.floor(s.total / 10));
    expect(Number(settled!.reward_minor)).toBe(0);
    expect((await db.query('SELECT 1 FROM shop_credit_ledger WHERE order_id=$1', [placed.orderId])).rowCount).toBe(0);
    const report = (await listReferralCodes(asAgent)).codes.find((c) => c.code === created.code)!;
    expect(report).toMatchObject({ kind: 'affiliate', name: 'Priya Blog', orders: 1, rewarded: 1, pending: 0, commission_bps: 1_000, net_minor: s.total, commission_minor: Math.floor(s.total / 10), credit_minor: 0 });
    expect(report.link).toBe(`${ORIGIN}/s/${handle}?ref=${created.code}`);
    // Customers' codes carry their own totals; the report is per workspace.
    const ashaRow = (await listReferralCodes(asAgent)).codes.find((c) => c.kind === 'contact' && c.contact_name === 'Customer asha')!;
    expect(ashaRow).toMatchObject({ rewarded: 1, credit_minor: 5_000 });
    expect((await listReferralCodes(otherAdmin)).codes.map((c) => c.code)).toEqual([foreignCode]);
    // Only admins switch a code off; another workspace's admin cannot touch it.
    await expect(updateReferralCode(asAgent, report.id, { active: false })).rejects.toThrow();
    await expect(updateReferralCode(otherAdmin, report.id, { active: false })).rejects.toMatchObject({ code: 'not_found' });
    await updateReferralCode(asAdmin, report.id, { active: false, commissionBps: 2_000 });
    expect((await listReferralCodes(asAdmin)).codes.find((c) => c.id === report.id)).toMatchObject({ active: false, commission_bps: 2_000 });
    // A customer's code never takes a commission.
    await updateReferralCode(asAdmin, ashaRow.id, { commissionBps: 900 });
    expect((await listReferralCodes(asAdmin)).codes.find((c) => c.id === ashaRow.id)?.commission_bps).toBeNull();
    // A code names a customer or a person, never both: the table says so too.
    await expect(db.query(`INSERT INTO shop_referral_codes(account_id,code,kind,contact_id,name) VALUES($1,'ABCDEFGH','contact',$2,'x')`, [account, contacts.s4])).rejects.toThrow();
    await expect(db.query(`INSERT INTO shop_referral_codes(account_id,code,kind,name) VALUES($1,'ABCDEFGH','affiliate',NULL)`, [account])).rejects.toThrow();
  });

  // ------------------------------------------------------------------ link page
  it('shows the link page in the shop theme with the admin\'s links and products, and nothing when it is off or the shop is locked', async () => {
    const featured = [ids.p2, ids.p1, ids.p3];
    await expect(saveLinkPage(asAdmin, parseLinkPage({ enabled: true, bio: 'Handmade', links: [], featured_product_ids: [ids.foreignProduct] }))).rejects.toMatchObject({ code: 'invalid' });
    expect(await loadPublicLinkPage(handle)).toBeNull();
    const saved = await saveLinkPage(asAdmin, parseLinkPage({
      enabled: true, bio: 'Handmade soaps and herbs', featured_product_ids: featured,
      links: [{ label: 'Instagram', url: 'https://instagram.com/ashashop' }, { label: 'Blog', url: 'http://blog.example.com/a?b=1' }],
    }));
    expect(saved).toMatchObject({ enabled: true, url: `${ORIGIN}/s/${handle}/links`, featured_product_ids: featured });
    const page = (await loadPublicLinkPage(handle))!;
    expect(page.shop.handle).toBe(handle);
    expect(page.bio).toBe('Handmade soaps and herbs');
    expect(page.links).toEqual([{ label: 'Instagram', url: 'https://instagram.com/ashashop' }, { label: 'Blog', url: 'http://blog.example.com/a?b=1' }]);
    // The admin's order, and a product that is only a draft is left out.
    expect(page.products.map((p) => p.id)).toEqual([ids.p2, ids.p1]);
    // A stored link that is not plain http(s) (written around the checks) is never shown; the table caps the list too.
    await db.query(`UPDATE shop_link_page SET links=$2::jsonb WHERE account_id=$1`, [account, JSON.stringify([{ label: 'Bad', url: 'javascript:alert(1)' }, { label: 'Good', url: 'https://example.com/x' }])]);
    expect((await loadPublicLinkPage(handle))!.links).toEqual([{ label: 'Good', url: 'https://example.com/x' }]);
    await expect(db.query(`UPDATE shop_link_page SET links=$2::jsonb WHERE account_id=$1`, [account, JSON.stringify(Array.from({ length: 13 }, () => ({ label: 'x', url: 'https://example.com' })))])).rejects.toThrow();
    // Another workspace's page is its own.
    expect(await getLinkPage(otherAdmin)).toMatchObject({ enabled: false, links: [] });
    // Locked shops and a page that is off show nothing.
    await db.query(`UPDATE shop_storefronts SET access_mode='password' WHERE account_id=$1`, [account]);
    expect(await loadPublicLinkPage(handle)).toBeNull();
    await db.query(`UPDATE shop_storefronts SET access_mode='coming_soon' WHERE account_id=$1`, [account]);
    expect(await loadPublicLinkPage(handle)).toBeNull();
    await db.query(`UPDATE shop_storefronts SET access_mode='open' WHERE account_id=$1`, [account]);
    expect(await loadPublicLinkPage(handle)).not.toBeNull();
    await saveLinkPage(asAdmin, parseLinkPage({ enabled: false, bio: null, links: [], featured_product_ids: [] }));
    expect(await loadPublicLinkPage(handle)).toBeNull();
    expect(await loadPublicLinkPage('no-such-shop')).toBeNull();
  });
});
