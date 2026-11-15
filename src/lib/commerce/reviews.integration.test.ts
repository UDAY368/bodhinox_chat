import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Store plan Phase 3 package 4 on PostgreSQL: product reviews asked on WhatsApp after delivery.
// Delivery queues one request three days later (only when the store setting is on); the job sends a
// star list inside the window, an approved MARKETING template outside it, and never twice; only the
// order's own contact can rate it, once per order and product, replay safe; the words after a rating
// are taken for 30 minutes; the public shop gets published reviews only, without phone or full name;
// another workspace's reviews are never visible; agents cannot moderate. Meta is never called.
const sends = vi.hoisted(() => ({ text: vi.fn(), template: vi.fn(), interactive: vi.fn() }));
vi.mock('@/lib/automations/meta-send', () => ({
  engineSendText: sends.text, engineSendTemplate: sends.template, engineSendInteractive: sends.interactive,
}));

import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { saveNoticeTemplate } from './notice-templates';
import { scheduleDeliveryFollowups } from './order-lifecycle';
import { loadShopAll, loadShopProduct } from './public-shop';
import { listReviews, moderateReview, parseReviewCursor } from './review-data';
import { handleReviewRating, handleReviewRequestJob, handleReviewText, reviewListPayload } from './review-jobs';
import { reviewReplyId } from './reviews';

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

const account = randomUUID(), other = randomUUID(), owner = randomUUID(), admin = randomUUID(), agent = randomUUID();
const asAdmin: TenantContext & { userId: string } = { accountId: account, userId: admin, role: 'admin' };
const asAgent: TenantContext & { userId: string } = { accountId: account, userId: agent, role: 'agent' };
const asOther: TenantContext & { userId: string } = { accountId: other, userId: owner, role: 'owner' };
const number = randomUUID(), otherNumber = randomUUID();
const productMain = randomUUID(), productSide = randomUUID(), productOther = randomUUID();
const variantMain = randomUUID(), variantSide = randomUUID(), variantOther = randomUUID();
const names = ['buyer', 'late', 'stranger', 'optedOut', 'blocked', 'paused', 'plain', 'otherBuyer'] as const;
type Who = (typeof names)[number];
const contacts = Object.fromEntries(names.map((n) => [n, randomUUID()])) as Record<Who, string>;
const conversations: Record<string, string> = {};
const handle = `rv-${account.slice(0, 8)}`;
const otherHandle = `rv-${other.slice(0, 8)}`;
const buyerPhone = '+14156000000';
let db: pg.Client;

const worker = <T,>(fn: (tx: TenantTransaction) => Promise<T>, ac = account) => withTenant({ accountId: ac, role: 'owner' }, fn, getWorkerPrisma());
const meta = { attempts: 1, maxAttempts: 3 };
const customerWrote = (who: Who, ago = '1 minute') => db.query(
  `INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,created_at)
   VALUES($1,$2,'customer','text','hi', now() - $3::interval)`, [who === 'otherBuyer' ? other : account, conversations[contacts[who]], ago]);

/** A delivered order of a contact: the main product (the highest-value line) and a cheaper side product. */
async function deliveredOrder(who: Who, { status = 'fulfilled', ac = account, main = variantMain, side = variantSide } = {}) {
  const id = (await db.query(
    `INSERT INTO orders(account_id,source,external_id,contact_id,conversation_id,currency,subtotal_minor,total_minor,status)
     VALUES($1,'manual',$2,$3,$4,'INR',60000,60000,$5) RETURNING id`,
    [ac, `RV-${randomUUID().slice(0, 8)}`, contacts[who], conversations[contacts[who]], status])).rows[0].id as string;
  await db.query(`INSERT INTO order_items(account_id,order_id,name,quantity,unit_price_minor,currency,variant_id) VALUES
    ($1,$2,'Side item',3,5000,'INR',$4),($1,$2,'Main item',1,45000,'INR',$3)`, [ac, id, main, side]);
  return id;
}
const ledger = async (orderId: string) => (await db.query(
  "SELECT status, reason FROM order_messages WHERE order_id=$1 AND kind='review_request'", [orderId])).rows[0];
const reviewsOf = async (orderId: string) => (await db.query(
  'SELECT id, product_id, contact_id, rating, body, status, reviewer_initial, rating_message_id, body_message_id FROM shop_reviews WHERE order_id=$1', [orderId])).rows;
const tap = (who: Who, orderId: string, productId: string, rating: number, messageId = randomUUID(), ac = account) => handleReviewRating({
  accountId: ac, contactId: contacts[who], conversationId: conversations[contacts[who]], messageId, replyId: reviewReplyId(orderId, productId, rating) });
const typed = (who: Who, text: string, messageId = randomUUID(), now?: Date) => handleReviewText({
  accountId: account, contactId: contacts[who], conversationId: conversations[contacts[who]], messageId, text }, undefined, now);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('store phase 3 product reviews on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P3 reviews', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[owner, admin, agent]]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P3 reviews',$3),($2,'P3 other',$3)", [account, other, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [account, other]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$2,'owner')",
      [account, owner, admin, agent, other]);
    await db.query(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,access_token,status,is_default)
      VALUES($1,$2,$3,$4,$8,'connected',true),($5,$6,$3,$7,$8,'connected',true)`,
    [number, account, owner, `pn-${account}`, otherNumber, other, `pn-${other}`, encrypt('token-test')]);
    for (const [i, key] of names.entries()) {
      const ac = key === 'otherBuyer' ? other : account;
      // The buyer's name is a full name and the phone is known: neither may reach the public page.
      await db.query('INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,$4,$5)',
        [contacts[key], ac, owner, key === 'buyer' ? 'Ravi Kumar' : `Person ${key}`, key === 'buyer' ? buyerPhone : `+14156${String(i + 1).padStart(5, '0')}`]);
      conversations[contacts[key]] = (await db.query('INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES($1,$2,$3,$4) RETURNING id',
        [ac, owner, contacts[key], key === 'otherBuyer' ? otherNumber : number])).rows[0].id;
    }
    await db.query("UPDATE contacts SET opted_out_at=now() WHERE id=$1", [contacts.optedOut]);
    await db.query("UPDATE contacts SET blocked_at=now() WHERE id=$1", [contacts.blocked]);
    await db.query("UPDATE conversations SET bot_paused=true WHERE id=$1", [conversations[contacts.paused]]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled)
      VALUES($1,'INR',true,1800,true),($2,'INR',true,1800,true)`, [account, other]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES
      ($1,$4,'Brahmi oil','published',now()),($2,$4,'Neem comb','published',now()),($3,$5,'Other oil','published',now())`,
    [productMain, productSide, productOther, account, other]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory) VALUES
      ($1,$4,$2,'BR-1',45000,false),($3,$4,$5,'NC-1',5000,false)`, [variantMain, productMain, variantSide, account, productSide]);
    await db.query('INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory) VALUES($1,$2,$3,$4,9900,false)',
      [variantOther, other, productOther, 'OT-1']);
    await db.query(`INSERT INTO shop_storefronts(account_id,handle,published,template,whatsapp_config_id,whatsapp_phone)
      VALUES($1,$2,true,'wellness',$3,'919800000000'),($4,$5,true,'fashion',$6,'919800000099')`,
    [account, handle, number, other, otherHandle, otherNumber]);
    await db.query(`INSERT INTO message_templates(account_id,user_id,name,language,category,status,body_text) VALUES
      ($1,$2,'rv_ask','en','Marketing','APPROVED','Hi {{1}}, how was {{2}} (order {{3}})? Reply with a number from 1 to 5.'),
      ($1,$2,'rv_util','en','Utility','APPROVED','Hi {{1}}')`, [account, owner]);
    await customerWrote('buyer');
    await customerWrote('stranger');
    await customerWrote('optedOut');
    await customerWrote('blocked');
    await customerWrote('paused');
    await customerWrote('otherBuyer');
    await customerWrote('late', '3 days');
    await customerWrote('plain', '3 days');
  });

  beforeEach(() => {
    sends.text.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.text' });
    sends.template.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.template' });
    sends.interactive.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.list' });
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[owner, admin, agent]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('queues one request three days after delivery, only when an admin switched it on', async () => {
    const order = await deliveredOrder('buyer');
    const queue = () => worker((tx) => scheduleDeliveryFollowups(tx, account, order));
    const jobs = async () => (await db.query("SELECT dedupe_key, run_at FROM jobs WHERE type='commerce.review_request' AND payload->>'orderId'=$1", [order])).rows;
    await queue();
    expect(await jobs()).toEqual([]);

    // Agents cannot switch it on (column grant and policy); an admin can.
    expect(await withTenant(asAgent, (tx) => tx.$executeRaw`UPDATE commerce_settings SET review_requests_enabled=true WHERE account_id=${account}::uuid`).catch(() => 0)).toBe(0);
    expect((await db.query('SELECT review_requests_enabled AS on FROM commerce_settings WHERE account_id=$1', [account])).rows[0].on).toBe(false);
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE commerce_settings SET review_requests_enabled=true WHERE account_id=${account}::uuid`)).resolves.toBe(1);
    const before = Date.now();
    await queue();
    await queue();
    const rows = await jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe(`review:${order}`);
    const days = (new Date(rows[0].run_at).getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(2.99);
    expect(days).toBeLessThan(3.01);
    // The feedback request of the same delivery is a separate job.
    expect((await db.query("SELECT count(*)::int AS n FROM jobs WHERE type='commerce.order_followup' AND payload->>'orderId'=$1 AND payload->>'kind'='feedback'", [order])).rows[0].n).toBe(1);
  });

  it('asks about the highest-value product with five star rows inside the window, once, replay safe', async () => {
    const order = await deliveredOrder('buyer');
    expect(await handleReviewRequestJob(account, { orderId: order }, meta)).toEqual({ status: 'sent', reason: 'list' });
    expect(sends.interactive).toHaveBeenCalledTimes(1);
    const sent = sends.interactive.mock.calls[0][0];
    expect(sent).toMatchObject({ accountId: account, contactId: contacts.buyer, conversationId: conversations[contacts.buyer] });
    expect(sent.payload).toEqual(reviewListPayload(order, productMain, 'Brahmi oil'));
    expect(sent.payload.body).toContain('Brahmi oil');
    const rows = sent.payload.sections.flatMap((s: { rows: { id: string; title: string }[] }) => s.rows);
    expect(rows.map((r: { id: string }) => r.id)).toEqual([5, 4, 3, 2, 1].map((n) => `rvw:${order}:${productMain}:${n}`));
    expect(rows.map((r: { title: string }) => r.title)).toEqual(['★★★★★', '★★★★', '★★★', '★★', '★']);
    expect(await ledger(order)).toEqual({ status: 'sent', reason: 'list' });
    // Run again, even after losing the ledger row: the accepted intent means nothing more is sent.
    expect(await handleReviewRequestJob(account, { orderId: order }, meta)).toBeNull();
    await db.query("DELETE FROM order_messages WHERE order_id=$1 AND kind='review_request'", [order]);
    expect(await handleReviewRequestJob(account, { orderId: order }, meta)).toMatchObject({ status: 'sent' });
    expect(sends.interactive).toHaveBeenCalledTimes(1);
    expect(sends.template).not.toHaveBeenCalled();
  });

  it('uses the approved marketing template outside the window, and records why it did not send', async () => {
    // No template set: blocked and recorded, nothing sent.
    const first = await deliveredOrder('late');
    expect(await handleReviewRequestJob(account, { orderId: first }, meta)).toEqual({ status: 'blocked', reason: 'no_template' });
    expect(await ledger(first)).toEqual({ status: 'blocked', reason: 'no_template' });
    // A utility template is the wrong category.
    await expect(saveNoticeTemplate(asAdmin, { kind: 'review_request', template: { name: 'rv_util', language: 'en' } })).rejects.toMatchObject({ code: 'wrong_category' });
    await saveNoticeTemplate(asAdmin, { kind: 'review_request', template: { name: 'rv_ask', language: 'en' } });
    const order = await deliveredOrder('late');
    expect(await handleReviewRequestJob(account, { orderId: order }, meta)).toEqual({ status: 'sent', reason: 'template' });
    expect(sends.template).toHaveBeenCalledTimes(1);
    expect(sends.template.mock.calls[0][0]).toMatchObject({ templateName: 'rv_ask', contactId: contacts.late, params: ['Person late', 'Brahmi oil', expect.any(String)] });
    expect(sends.interactive).not.toHaveBeenCalled();
    expect(await handleReviewRequestJob(account, { orderId: order }, meta)).toBeNull();
    expect(sends.template).toHaveBeenCalledTimes(1);
  });

  it('skips and records refusals before anything is sent: consent, takeover, setting, status, no product', async () => {
    const outcome = async (order: string) => { await handleReviewRequestJob(account, { orderId: order }, meta); return ledger(order); };
    expect(await outcome(await deliveredOrder('optedOut'))).toEqual({ status: 'skipped', reason: 'opted_out' });
    expect(await outcome(await deliveredOrder('blocked'))).toEqual({ status: 'skipped', reason: 'contact_blocked' });
    expect(await outcome(await deliveredOrder('paused'))).toEqual({ status: 'blocked', reason: 'bot_paused' });
    expect(await outcome(await deliveredOrder('buyer', { status: 'dispatched' }))).toEqual({ status: 'skipped', reason: 'stale_status' });
    const refunded = await deliveredOrder('buyer');
    await db.query("UPDATE orders SET refund_state='full' WHERE id=$1", [refunded]);
    expect(await outcome(refunded)).toEqual({ status: 'skipped', reason: 'refunded' });
    // An order of products that are not in the catalogue has nothing to rate.
    const custom = (await db.query(`INSERT INTO orders(account_id,source,external_id,contact_id,currency,subtotal_minor,total_minor,status)
      VALUES($1,'manual',$2,$3,'INR',100,100,'fulfilled') RETURNING id`, [account, `RV-${randomUUID().slice(0, 8)}`, contacts.buyer])).rows[0].id as string;
    await db.query("INSERT INTO order_items(account_id,order_id,name,quantity,unit_price_minor,currency) VALUES($1,$2,'Custom',1,100,'INR')", [account, custom]);
    expect(await outcome(custom)).toEqual({ status: 'skipped', reason: 'no_product' });
    // A review already exists: nothing to ask again.
    const rated = await deliveredOrder('buyer');
    await tap('buyer', rated, productMain, 4);
    expect(await outcome(rated)).toEqual({ status: 'skipped', reason: 'already_reviewed' });
    // The setting is read again when the job runs.
    const off = await deliveredOrder('buyer');
    await db.query('UPDATE commerce_settings SET review_requests_enabled=false WHERE account_id=$1', [account]);
    try { expect(await outcome(off)).toEqual({ status: 'skipped', reason: 'disabled' }); }
    finally { await db.query('UPDATE commerce_settings SET review_requests_enabled=true WHERE account_id=$1', [account]); }
    expect(sends.interactive).not.toHaveBeenCalled();
    expect(sends.template).not.toHaveBeenCalled();
    expect(sends.text).toHaveBeenCalledTimes(1);
  });

  it('records an uncertain send for staff and never sends it again', async () => {
    const order = await deliveredOrder('buyer');
    sends.interactive.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(handleReviewRequestJob(account, { orderId: order }, meta)).rejects.toThrow();
    expect(await ledger(order)).toEqual({ status: 'outcome_unknown', reason: 'uncertain' });
    expect(await handleReviewRequestJob(account, { orderId: order }, { attempts: 3, maxAttempts: 3 })).toEqual({ status: 'outcome_unknown', reason: 'uncertain' });
    expect(sends.interactive).toHaveBeenCalledTimes(1);
  });

  it('lets only the order\'s own contact rate it, once per order and product, and thanks once', async () => {
    const order = await deliveredOrder('buyer');
    const foreign = await deliveredOrder('otherBuyer', { ac: other, main: variantOther, side: variantOther });
    // Someone else's tap, another workspace's order, a product that is not on the order, an order not yet delivered.
    expect(await tap('stranger', order, productMain, 5)).toEqual({ handled: false, outcome: 'ignored' });
    expect(await tap('buyer', foreign, productOther, 5)).toMatchObject({ handled: false });
    expect(await tap('otherBuyer', order, productMain, 5, randomUUID(), other)).toMatchObject({ handled: false });
    expect(await tap('buyer', order, productOther, 5)).toMatchObject({ handled: false });
    const open = await deliveredOrder('buyer', { status: 'dispatched' });
    expect(await tap('buyer', open, productMain, 5)).toMatchObject({ handled: false });
    expect(await reviewsOf(order)).toEqual([]);
    expect(sends.text).not.toHaveBeenCalled();

    const messageId = randomUUID();
    expect(await tap('buyer', order, productMain, 5, messageId)).toEqual({ handled: true, outcome: 'rated' });
    expect(sends.text).toHaveBeenCalledTimes(1);
    expect(sends.text.mock.calls[0][0]).toMatchObject({ contactId: contacts.buyer, text: 'Thanks! Add a few words about it, or just skip.' });
    const [review] = await reviewsOf(order);
    expect(review).toMatchObject({ product_id: productMain, contact_id: contacts.buyer, rating: 5, status: 'pending', body: null, reviewer_initial: 'R.' });

    // A replay of the same message, and a changed mind while still pending: one row, one thank-you.
    expect(await tap('buyer', order, productMain, 5, messageId)).toEqual({ handled: true, outcome: 'rated' });
    expect(await tap('buyer', order, productMain, 3)).toEqual({ handled: true, outcome: 'rated' });
    const rows = await reviewsOf(order);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: review.id, rating: 3, status: 'pending' });
    expect(sends.text).toHaveBeenCalledTimes(1);
    // The table itself allows one review per order and product.
    await expect(db.query("INSERT INTO shop_reviews(account_id,product_id,order_id,rating) VALUES($1,$2,$3,4)", [account, productMain, order])).rejects.toThrow(/order_id_product_id_key/);
    // The side product of the same order can be rated on its own.
    expect(await tap('buyer', order, productSide, 4)).toMatchObject({ handled: true });
    expect(await reviewsOf(order)).toHaveLength(2);

    // Once an admin moderated it, a later tap cannot change it.
    await moderateReview(asAdmin, review.id, 'published');
    expect(await tap('buyer', order, productMain, 1)).toMatchObject({ handled: true });
    expect((await reviewsOf(order)).find((r) => r.id === review.id)).toMatchObject({ rating: 3, status: 'published' });
  });

  it('takes the next plain message within 30 minutes as the review text, never a command, and replay safe', async () => {
    // Reviews this buyer left in earlier tests do not take part.
    await db.query('UPDATE shop_reviews SET body_closed_at=now() WHERE contact_id=$1 AND body_closed_at IS NULL', [contacts.buyer]);
    const order = await deliveredOrder('buyer');
    await tap('buyer', order, productMain, 5);
    const [{ id }] = await reviewsOf(order);
    const body = async () => (await db.query('SELECT body, body_closed_at FROM shop_reviews WHERE id=$1', [id])).rows[0];

    // A shop command or STOP is not text for the review and leaves the chance open.
    expect(await typed('buyer', 'ORDER ABC234')).toEqual({ handled: false, outcome: 'ignored' });
    expect(await typed('buyer', 'stop')).toEqual({ handled: false, outcome: 'ignored' });
    expect((await body()).body).toBeNull();
    // Someone else's message is never taken.
    expect(await typed('stranger', 'Great oil')).toEqual({ handled: false, outcome: 'ignored' });

    const messageId = randomUUID();
    expect(await typed('buyer', '  Lovely\u0000 smell,\n\nsoft hair  ', messageId)).toEqual({ handled: true, outcome: 'body' });
    expect((await body()).body).toBe('Lovely smell, soft hair');
    // A retried job finds its own message again; a later message is ordinary text.
    expect(await typed('buyer', 'Lovely smell, soft hair', messageId)).toEqual({ handled: true, outcome: 'body' });
    expect(await typed('buyer', 'Something else')).toEqual({ handled: false, outcome: 'ignored' });
    expect((await body()).body).toBe('Lovely smell, soft hair');
    // No thank-you for the words: only the rating got one.
    expect(sends.text).toHaveBeenCalledTimes(1);

    // After 30 minutes the chance is gone.
    const late = await deliveredOrder('buyer');
    await tap('buyer', late, productMain, 4);
    await db.query("UPDATE shop_reviews SET rated_at=now() - interval '31 minutes' WHERE order_id=$1", [late]);
    expect(await typed('buyer', 'Too late for this')).toEqual({ handled: false, outcome: 'ignored' });
    expect((await reviewsOf(late))[0].body).toBeNull();

    // "skip" closes the chance and stores nothing; a long text is cut to 1000 characters.
    const skipped = await deliveredOrder('buyer');
    await tap('buyer', skipped, productMain, 2);
    expect(await typed('buyer', 'Skip')).toEqual({ handled: true, outcome: 'skipped' });
    expect(await typed('buyer', 'now I have words')).toEqual({ handled: false, outcome: 'ignored' });
    expect((await reviewsOf(skipped))[0].body).toBeNull();
    const long = await deliveredOrder('buyer');
    await tap('buyer', long, productMain, 5);
    await typed('buyer', 'x'.repeat(1500));
    expect((await reviewsOf(long))[0].body).toHaveLength(1000);

    // A review an admin already published keeps its text, whatever the buyer sends next.
    const published = await deliveredOrder('buyer');
    await tap('buyer', published, productMain, 5);
    await moderateReview(asAdmin, (await reviewsOf(published))[0].id, 'published');
    expect(await typed('buyer', 'Adding words after publishing')).toEqual({ handled: false, outcome: 'ignored' });
    expect((await reviewsOf(published))[0].body).toBeNull();
  });

  it('accepts a typed 1 to 5 only after a template request from that contact, within seven days, once', async () => {
    const order = await deliveredOrder('late');
    await db.query("INSERT INTO order_messages(account_id,order_id,kind,status,reason) VALUES($1,$2,'review_request','sent','template')", [account, order]);
    // Nothing was asked of these contacts (or it was asked with the list), so a digit is an ordinary message.
    expect(await typed('stranger', '5')).toEqual({ handled: false, outcome: 'ignored' });
    const listed = await deliveredOrder('plain');
    await db.query("INSERT INTO order_messages(account_id,order_id,kind,status,reason) VALUES($1,$2,'review_request','sent','list')", [account, listed]);
    expect(await typed('plain', '5')).toEqual({ handled: false, outcome: 'ignored' });
    expect(await reviewsOf(listed)).toEqual([]);

    const messageId = randomUUID();
    expect(await typed('late', '4', messageId)).toEqual({ handled: true, outcome: 'rated' });
    expect(await reviewsOf(order)).toMatchObject([{ product_id: productMain, contact_id: contacts.late, rating: 4, status: 'pending', reviewer_initial: 'P.' }]);
    expect(sends.text).toHaveBeenCalledTimes(1);
    // A replay finds its own rating; a second digit later is ordinary text (the product already has a rating).
    expect(await typed('late', '4', messageId)).toEqual({ handled: true, outcome: 'rated' });
    expect(await typed('late', '2')).toEqual({ handled: true, outcome: 'body' });
    expect(await reviewsOf(order)).toMatchObject([{ rating: 4, body: '2' }]);
    expect(sends.text).toHaveBeenCalledTimes(1);

    // A request older than seven days no longer counts.
    const stale = await deliveredOrder('late');
    await db.query("DELETE FROM order_messages WHERE kind='review_request' AND order_id IN (SELECT id FROM orders WHERE contact_id=$1)", [contacts.late]);
    await db.query("INSERT INTO order_messages(account_id,order_id,kind,status,reason,updated_at) VALUES($1,$2,'review_request','sent','template', now() - interval '8 days')", [account, stale]);
    expect(await typed('late', '5')).toEqual({ handled: false, outcome: 'ignored' });
    expect(await reviewsOf(stale)).toEqual([]);
  });

  it('shows only published reviews to the public shop, without phone number, full name or contact', async () => {
    const order = await deliveredOrder('buyer');
    await tap('buyer', order, productMain, 4);
    await typed('buyer', 'Does what it says');
    const [pending] = await reviewsOf(order);
    const before = await loadShopProduct(handle, productMain);
    expect(before?.reviews.latest.map((r) => r.body)).not.toContain('Does what it says');

    await moderateReview(asAdmin, pending.id, 'published');
    const page = await loadShopProduct(handle, productMain);
    expect(page?.reviews.summary?.count).toBeGreaterThanOrEqual(2);
    const mine = page!.reviews.latest.find((r) => r.body === 'Does what it says');
    expect(mine).toMatchObject({ rating: 4, reviewer: 'R.' });
    expect(Object.keys(mine!).sort()).toEqual(['body', 'date', 'rating', 'reviewer']);
    const json = JSON.stringify(page);
    expect(json).not.toContain('Ravi Kumar');
    expect(json).not.toContain('Kumar');
    expect(json).not.toContain(buyerPhone);
    expect(json).not.toContain('4156000000');
    expect(json).not.toContain(contacts.buyer);
    expect(page!.reviews.latest.length).toBeLessThanOrEqual(10);

    // Hiding takes it off again.
    await moderateReview(asAdmin, pending.id, 'hidden');
    expect((await loadShopProduct(handle, productMain))?.reviews.latest.map((r) => r.body)).not.toContain('Does what it says');

    // Product cards: one grouped query gives each product its average and count; unrated products have none.
    const all = await loadShopAll(handle);
    const main = all!.products.find((p) => p.id === productMain)!;
    const published = (await db.query("SELECT rating FROM shop_reviews WHERE product_id=$1 AND status='published'", [productMain])).rows.map((r) => r.rating as number);
    expect(main.rating?.count).toBe(published.length);
    expect(main.rating?.average).toBe(Math.round((published.reduce((a, b) => a + b, 0) / published.length) * 10) / 10);
    expect(all!.products.find((p) => p.id === productSide)!.rating).toBeNull();
  });

  it('never shows another workspace\'s reviews, and keeps moderation to admins of this workspace', async () => {
    const foreign = await deliveredOrder('otherBuyer', { ac: other, main: variantOther, side: variantOther });
    await tap('otherBuyer', foreign, productOther, 5, randomUUID(), other);
    const theirs = (await db.query('SELECT id FROM shop_reviews WHERE order_id=$1', [foreign])).rows[0].id as string;
    await moderateReview(asOther, theirs, 'published');

    expect((await loadShopProduct(otherHandle, productOther))?.reviews.summary).toMatchObject({ count: 1, average: 5 });
    // Their handle never shows our product, and ours never shows theirs.
    expect(await loadShopProduct(otherHandle, productMain)).toBeNull();
    expect(await loadShopProduct(handle, productOther)).toBeNull();
    const ours = await listReviews(asAdmin, { status: null, before: null });
    expect(ours.reviews.length).toBeGreaterThan(3);
    expect(ours.reviews.map((r) => r.id)).not.toContain(theirs);
    expect((await listReviews(asOther, { status: null, before: null })).reviews.map((r) => r.id)).toEqual([theirs]);
    // Another workspace's admin cannot publish or hide ours.
    await expect(moderateReview(asOther, ours.reviews[0].id, 'hidden')).rejects.toMatchObject({ code: 'not_found' });

    // Agents read but cannot moderate: the policy leaves no row to update, and the API says not found.
    const mine = ours.reviews.find((r) => r.status === 'pending') ?? ours.reviews[0];
    await expect(moderateReview(asAgent, mine.id, 'published')).rejects.toMatchObject({ code: 'not_found' });
    expect((await db.query('SELECT status FROM shop_reviews WHERE id=$1', [mine.id])).rows[0].status).toBe(mine.status);
    expect((await listReviews(asAgent, { status: null, before: null })).reviews.length).toBe(ours.reviews.length);
    // Admins may change only the status columns: not the rating, the text or the owner.
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE shop_reviews SET rating=1 WHERE id=${mine.id}::uuid`)).rejects.toThrow();
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE shop_reviews SET body='edited' WHERE id=${mine.id}::uuid`)).rejects.toThrow();
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`DELETE FROM shop_reviews WHERE id=${mine.id}::uuid`)).rejects.toThrow();
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`INSERT INTO shop_reviews(account_id,product_id,order_id,rating) VALUES(${account}::uuid,${productMain}::uuid,${randomUUID()}::uuid,5)`)).rejects.toThrow();
    // Bad input is refused before the database.
    await expect(moderateReview(asAdmin, mine.id, 'pending')).rejects.toMatchObject({ code: 'invalid' });
    await expect(moderateReview(asAdmin, 'not-a-uuid', 'hidden')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lists reviews newest first with a status filter and a paging cursor, and audits ids only', async () => {
    const all = await listReviews(asAdmin, { status: null, before: null });
    const times = all.reviews.map((r) => r.created_at);
    expect([...times].sort().reverse()).toEqual(times);
    const published = await listReviews(asAdmin, { status: 'published', before: null });
    expect(published.reviews.length).toBeGreaterThan(0);
    expect(published.reviews.every((r) => r.status === 'published')).toBe(true);
    expect(Object.keys(all.reviews[0]).sort()).toEqual(['body', 'created_at', 'id', 'product_id', 'product_name', 'rating', 'reviewer', 'status']);
    // The cursor continues strictly after the row it names.
    const cursor = parseReviewCursor(`${all.reviews[1].created_at}|${all.reviews[1].id}`);
    const rest = await listReviews(asAdmin, { status: null, before: cursor });
    expect(rest.reviews.map((r) => r.id)).toEqual(all.reviews.slice(2).map((r) => r.id));
    expect(parseReviewCursor('nonsense')).toBeNull();
    expect(parseReviewCursor(`${all.reviews[0].created_at}|not-a-uuid`)).toBeNull();

    const audit = (await db.query("SELECT resource_id, metadata FROM audit_logs WHERE account_id=$1 AND action='commerce.review_moderated' ORDER BY created_at DESC LIMIT 1", [account])).rows[0];
    expect(Object.keys(audit.metadata)).toEqual(['status']);
    expect(JSON.stringify(audit)).not.toMatch(/Ravi|Kumar|4156/);
  });
});
