import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Store plan Phase 3 package 3 on PostgreSQL: "Notify me on WhatsApp" for a sold-out variant.
// A code exists only for an out-of-stock, published, tracked variant; the first sender of
// "NOTIFY <CODE>" owns it (another workspace, number or sender never matches); a restock
// queues one job per movement; the job messages each claimed buyer once (replay safe), skips
// blocked and opted-out contacts, and the app role cannot write alerts. Meta is never called.
const sends = vi.hoisted(() => ({ text: vi.fn(), template: vi.fn(), interactive: vi.fn(), apiText: vi.fn() }));
vi.mock('@/lib/automations/meta-send', () => ({
  engineSendText: sends.text, engineSendTemplate: sends.template, engineSendInteractive: sends.interactive,
}));
vi.mock('@/lib/whatsapp/meta-api', async (original) => ({
  ...(await original<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTextMessage: (...args: unknown[]) => sends.apiText(...args),
}));

import { POST as notify } from '@/app/api/public/store/[handle]/notify/route';
import { getShopProduct } from './catalogue/products';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { saveNoticeTemplate } from './notice-templates';
import { newCartCode } from './public-shop';
import { handleBackInStockJob, handleStockAlertCode } from './stock-alert-jobs';
import { adjustTx } from './stock';

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

const account = randomUUID(), other = randomUUID(), owner = randomUUID(), admin = randomUUID(), agent = randomUUID();
const asAdmin: TenantContext & { userId: string } = { accountId: account, userId: admin, role: 'admin' };
const asAgent: TenantContext & { userId: string } = { accountId: account, userId: agent, role: 'agent' };
const asOther: TenantContext & { userId: string } = { accountId: other, userId: owner, role: 'owner' };
const number = randomUUID(), otherNumber = randomUUID(), product = randomUUID(), draftProduct = randomUUID(), otherProduct = randomUUID();
const names = ['buyer', 'buyer2', 'blocked', 'optedOut', 'late', 'stranger', 'otherBuyer'] as const;
const contacts = Object.fromEntries(names.map((n) => [n, randomUUID()])) as Record<(typeof names)[number], string>;
const conversations: Record<string, string> = {};
const variants = Object.fromEntries(['main', 'consent', 'template', 'bulk', 'inStock', 'madeToOrder', 'draft', 'foreign'].map((n) => [n, randomUUID()])) as Record<string, string>;
const handle = `p3-${account.slice(0, 8)}`;
let db: pg.Client;
let ip = 0;

const worker = <T,>(fn: (tx: TenantTransaction) => Promise<T>, ac = account) => withTenant({ accountId: ac, role: 'owner' }, fn, getWorkerPrisma());
const at = { params: Promise.resolve({ handle }) };
const req = (body: unknown, origin: string | null = ORIGIN) => new Request(`${ORIGIN}/api/public/store/x/notify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), 'x-forwarded-for': `203.0.113.${(ip++ % 200) + 1}` },
  body: JSON.stringify(body),
});
const customerWrote = (contactKey: keyof typeof contacts, ago = '1 minute') => db.query(
  `INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,created_at)
   VALUES($1,$2,'customer','text','hi', now() - $3::interval)`, [account, conversations[contacts[contactKey]], ago]);
const restock = (variantId: string, delta: number) => worker((tx) => adjustTx(tx, account,
  { variantId, delta, kind: delta > 0 ? 'receipt' : 'adjustment', reason: null, actorUserId: null }));
const jobs = async (variantId: string) => (await db.query("SELECT dedupe_key FROM jobs WHERE type='commerce.back_in_stock' AND dedupe_key LIKE $1",
  [`bis:${variantId}:%`])).rows.map((r) => r.dedupe_key as string);
const alertRow = async (id: string) => (await db.query(
  'SELECT contact_id, claimed_at, notified_at, closed_at, skip_reason FROM shop_stock_alerts WHERE id=$1', [id])).rows[0];

/** An unclaimed code for a variant, then the buyer's "NOTIFY <CODE>" through the inbound claim. */
async function claim(variantId: string, who: keyof typeof contacts, { ac = account, num = number } = {}) {
  const code = newCartCode();
  const id = (await db.query(`INSERT INTO shop_stock_alerts(account_id,code,variant_id,expires_at) VALUES($1,$2,$3,now() + interval '48 hours') RETURNING id`,
    [ac, code, variantId])).rows[0].id as string;
  const result = await handleStockAlertCode({ accountId: ac, contactId: contacts[who], conversationId: conversations[contacts[who]], whatsappConfigId: num, code });
  return { id, code, result };
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('store phase 3 back-in-stock alerts on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P3 alerts', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[owner, admin, agent]]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P3 alerts',$3),($2,'P3 other',$3)", [account, other, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [account, other]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$2,'owner')",
      [account, owner, admin, agent, other]);
    await db.query(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,access_token,status,is_default)
      VALUES($1,$2,$3,$4,$8,'connected',true),($5,$6,$3,$7,$8,'connected',true)`,
    [number, account, owner, `pn-${account}`, otherNumber, other, `pn-${other}`, encrypt('token-test')]);
    for (const [i, key] of names.entries()) {
      const ac = key === 'otherBuyer' ? other : account;
      await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,$4,$5)`,
        [contacts[key], ac, owner, `Buyer ${key}`, `+14156${String(i).padStart(5, '0')}`]);
      conversations[contacts[key]] = (await db.query(`INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES($1,$2,$3,$4) RETURNING id`,
        [ac, owner, contacts[key], key === 'otherBuyer' ? otherNumber : number])).rows[0].id;
    }
    await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled)
      VALUES($1,'INR',true,1800,true),($2,'INR',true,1800,true)`, [account, other]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES
      ($1,$3,'Tulsi drops','published',now()),($2,$3,'Draft drops','draft',now()),($4,$5,'Other drops','published',now())`,
    [product, draftProduct, account, otherProduct, other]);
    const row = (key: string, p: string, ac: string, sku: string, track: boolean, options = '{}') =>
      db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory,option_values) VALUES($1,$2,$3,$4,49900,$5,$6::jsonb)`,
        [variants[key], ac, p, sku, track, options]);
    await row('main', product, account, 'TUL-60', true, '{"Size":"60ml"}');
    await row('consent', product, account, 'TUL-30', true);
    await row('template', product, account, 'TUL-90', true);
    await row('bulk', product, account, 'TUL-BULK', true);
    await row('inStock', product, account, 'TUL-IN', true);
    await row('madeToOrder', product, account, 'TUL-MTO', false);
    await row('draft', draftProduct, account, 'DRF-1', true);
    await row('foreign', otherProduct, other, 'OTH-1', true);
    await db.query('INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,5)', [account, variants.inStock]);
    await db.query(`INSERT INTO shop_storefronts(account_id,handle,published,template,whatsapp_config_id,whatsapp_phone)
      VALUES($1,$2,true,'wellness',$3,'919800000000'),($4,$5,true,'fashion',$6,'919800000099')`,
    [account, handle, number, other, `p3-${other.slice(0, 8)}`, otherNumber]);
    await db.query(`INSERT INTO message_templates(account_id,user_id,name,language,category,status,body_text)
      VALUES($1,$2,'bis_offer','en','Marketing','APPROVED','Hi {{1}}, {{2}} is back: {{3}}'),($1,$2,'bis_util','en','Utility','APPROVED','Hi {{1}}')`, [account, owner]);
    for (const key of ['buyer', 'buyer2', 'blocked', 'optedOut', 'stranger'] as const) await customerWrote(key);
  });

  beforeEach(() => {
    sends.text.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.text' });
    sends.template.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.template' });
    sends.apiText.mockReset().mockImplementation(async () => ({ messageId: `wamid.ack.${randomUUID()}` }));
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

  it('gives a code only for an out-of-stock variant of a published product, with the wa.me message ending in NOTIFY <code>', async () => {
    const res = await notify(req({ variantId: variants.main }), at);
    expect(res.status).toBe(200);
    const { code, whatsappUrl } = await res.json();
    expect(whatsappUrl).toMatch(/^https:\/\/wa\.me\/919800000000\?text=/);
    const text = decodeURIComponent(whatsappUrl.split('text=')[1]);
    expect(text).toContain('Tulsi drops (60ml)');
    expect(text.endsWith(`NOTIFY ${code}`)).toBe(true);
    const saved = (await db.query('SELECT variant_id, contact_id, expires_at FROM shop_stock_alerts WHERE account_id=$1 AND code=$2', [account, code])).rows[0];
    expect(saved.variant_id).toBe(variants.main);
    expect(saved.contact_id).toBeNull();
    const hours = (new Date(saved.expires_at).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThan(48.1);

    const refusal = async (variantId: unknown) => { const r = await notify(req({ variantId }), at); return [r.status, (await r.json()).code]; };
    expect(await refusal(variants.inStock)).toEqual([409, 'in_stock']);
    expect(await refusal(variants.madeToOrder)).toEqual([400, 'variant_unavailable']);
    expect(await refusal(variants.draft)).toEqual([400, 'variant_unavailable']);
    // Another workspace's variant is not this shop's.
    expect(await refusal(variants.foreign)).toEqual([400, 'variant_unavailable']);
    expect(await refusal('not-a-uuid')).toEqual([400, 'invalid']);
    // No WhatsApp number on the shop: nothing to message.
    await db.query('UPDATE shop_storefronts SET whatsapp_phone=NULL WHERE account_id=$1', [account]);
    try { expect(await refusal(variants.main)).toEqual([409, 'whatsapp_order_unavailable']); }
    finally { await db.query("UPDATE shop_storefronts SET whatsapp_phone='919800000000' WHERE account_id=$1", [account]); }
    expect((await db.query('SELECT count(*)::int AS n FROM shop_stock_alerts WHERE account_id=$1 AND variant_id=ANY($2::uuid[])',
      [account, [variants.inStock, variants.madeToOrder, variants.draft, variants.foreign]])).rows[0].n).toBe(0);
  });

  it('refuses a request from another origin before saving anything', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM shop_stock_alerts WHERE account_id=$1', [account])).rows[0].n;
    expect((await notify(req({ variantId: variants.main }, 'https://evil.example'), at)).status).toBe(403);
    expect((await notify(req({ variantId: variants.main }, null), at)).status).toBe(403);
    expect((await db.query('SELECT count(*)::int AS n FROM shop_stock_alerts WHERE account_id=$1', [account])).rows[0].n).toBe(before);
    // An unpublished or unknown handle is the plain 404.
    expect((await notify(req({ variantId: variants.main }), { params: Promise.resolve({ handle: 'no-such-shop' }) })).status).toBe(404);
  });

  it('gives a code to the first sender only, never across workspaces or numbers, and acknowledges once', async () => {
    const code = newCartCode();
    const id = (await db.query(`INSERT INTO shop_stock_alerts(account_id,code,variant_id,expires_at) VALUES($1,$2,$3,now() + interval '48 hours') RETURNING id`,
      [account, code, variants.main])).rows[0].id as string;
    const input = (who: keyof typeof contacts, ac = account, num: string | null = number) =>
      ({ accountId: ac, contactId: contacts[who], conversationId: conversations[contacts[who]], whatsappConfigId: num, code });

    // Another workspace never sees it, and a message to another number of this workspace is not the shop's.
    expect(await handleStockAlertCode(input('otherBuyer', other, otherNumber))).toMatchObject({ handled: false });
    expect(await handleStockAlertCode(input('buyer', account, otherNumber))).toMatchObject({ handled: false, outcome: 'code_unknown' });
    expect((await alertRow(id)).contact_id).toBeNull();
    expect(sends.apiText).not.toHaveBeenCalled();

    expect(await handleStockAlertCode(input('buyer'))).toEqual({ handled: true, outcome: 'acked' });
    expect(sends.apiText).toHaveBeenCalledTimes(1);
    expect(String((sends.apiText.mock.calls[0][0] as { text: string }).text)).toBe("We'll message you when it's back.");
    const claimed = await alertRow(id);
    expect(claimed.contact_id).toBe(contacts.buyer);
    expect(claimed.claimed_at).not.toBeNull();
    const days = (new Date((await db.query('SELECT claim_expires_at FROM shop_stock_alerts WHERE id=$1', [id])).rows[0].claim_expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);

    // The same sender again (a retried job) sends nothing new; a second sender gets ordinary text.
    expect(await handleStockAlertCode(input('buyer'))).toEqual({ handled: true, outcome: 'acked' });
    expect(sends.apiText).toHaveBeenCalledTimes(1);
    expect(await handleStockAlertCode(input('stranger'))).toMatchObject({ handled: false, outcome: 'code_unknown' });
    expect((await alertRow(id)).contact_id).toBe(contacts.buyer);

    // An unknown code and an expired unclaimed one are ordinary text too.
    expect(await handleStockAlertCode({ ...input('buyer'), code: 'ZZZZZ2' })).toMatchObject({ handled: false, outcome: 'code_unknown' });
    const expired = newCartCode();
    await db.query(`INSERT INTO shop_stock_alerts(account_id,code,variant_id,expires_at) VALUES($1,$2,$3,now() - interval '1 minute')`, [account, expired, variants.consent]);
    expect(await handleStockAlertCode({ ...input('buyer2'), code: expired })).toMatchObject({ handled: false, outcome: 'code_unknown' });
    expect(sends.apiText).toHaveBeenCalledTimes(1);

    // A second code for the same contact and variant is closed as a duplicate and only acknowledged.
    const duplicate = await claim(variants.main, 'buyer');
    expect(duplicate.result).toEqual({ handled: true, outcome: 'acked' });
    expect(await alertRow(duplicate.id)).toMatchObject({ contact_id: contacts.buyer, skip_reason: 'duplicate' });
    expect((await alertRow(duplicate.id)).closed_at).not.toBeNull();
    expect((await db.query('SELECT count(*)::int AS n FROM shop_stock_alerts WHERE contact_id=$1 AND variant_id=$2 AND closed_at IS NULL',
      [contacts.buyer, variants.main])).rows[0].n).toBe(1);
    // The table itself allows one open alert per contact and variant.
    await expect(db.query(`INSERT INTO shop_stock_alerts(account_id,code,variant_id,contact_id,expires_at,claimed_at,claim_expires_at)
      VALUES($1,$2,$3,$4,now(),now(),now())`, [account, newCartCode(), variants.main, contacts.buyer])).rejects.toThrow(/open_contact_variant/);
  });

  it('queues one job per restock movement and messages each claimed buyer once, even when the job is replayed', async () => {
    const { id } = await db.query('SELECT id FROM shop_stock_alerts WHERE contact_id=$1 AND variant_id=$2 AND closed_at IS NULL',
      [contacts.buyer, variants.main]).then((r) => r.rows[0]);
    expect(await jobs(variants.main)).toEqual([]);
    // Stock that stays at zero, or falls, wakes nobody.
    await restock(variants.main, 4);
    const [first, ...rest] = await jobs(variants.main);
    expect(rest).toEqual([]);
    expect(first).toMatch(new RegExp(`^bis:${variants.main}:[0-9a-f-]{36}$`));
    // More stock while it is already in stock queues nothing more.
    await restock(variants.main, 2);
    expect(await jobs(variants.main)).toHaveLength(1);

    const result = await handleBackInStockJob(account, { variantId: variants.main });
    expect(result).toEqual({ sent: 1, closed: 0, deferred: 0 });
    expect(sends.text).toHaveBeenCalledTimes(1);
    const sent = sends.text.mock.calls[0][0];
    expect(sent).toMatchObject({ accountId: account, contactId: contacts.buyer, conversationId: conversations[contacts.buyer] });
    expect(sent.text).toContain('Tulsi drops (60ml)');
    expect(sent.text).toContain(`${new URL(process.env.APP_URL!).origin}/s/${handle}/p/${product}`);
    expect(await alertRow(id)).toMatchObject({ skip_reason: null });
    expect((await alertRow(id)).notified_at).not.toBeNull();

    // The job runs again: nothing is left to send.
    expect(await handleBackInStockJob(account, { variantId: variants.main })).toEqual({ sent: 0, closed: 0, deferred: 0 });
    // A crash after the send but before the record: the accepted intent settles it without a second send.
    await db.query('UPDATE shop_stock_alerts SET notified_at=NULL, closed_at=NULL WHERE id=$1', [id]);
    expect(await handleBackInStockJob(account, { variantId: variants.main })).toEqual({ sent: 1, closed: 0, deferred: 0 });
    expect(sends.text).toHaveBeenCalledTimes(1);
    expect((await alertRow(id)).notified_at).not.toBeNull();

    // Sold out again and back again is a new movement and a new job; with no one waiting it queues nothing.
    await restock(variants.main, -6);
    await restock(variants.main, 1);
    expect(await jobs(variants.main)).toHaveLength(1);
  });

  it('closes a blocked or opted-out contact for good, and leaves an alert waiting when the variant is sold out again', async () => {
    const blocked = await claim(variants.consent, 'blocked');
    const optedOut = await claim(variants.consent, 'optedOut');
    const fine = await claim(variants.consent, 'buyer2');
    await db.query('UPDATE contacts SET blocked_at=now() WHERE id=$1', [contacts.blocked]);
    await db.query('UPDATE contacts SET opted_out_at=now() WHERE id=$1', [contacts.optedOut]);
    // Sold out: the job leaves every alert waiting.
    expect(await handleBackInStockJob(account, { variantId: variants.consent })).toEqual({ sent: 0, closed: 0, deferred: 0 });
    await restock(variants.consent, 3);
    expect(await jobs(variants.consent)).toHaveLength(1);
    expect(await handleBackInStockJob(account, { variantId: variants.consent })).toEqual({ sent: 1, closed: 2, deferred: 0 });
    expect(sends.text).toHaveBeenCalledTimes(1);
    expect(sends.text.mock.calls[0][0]).toMatchObject({ contactId: contacts.buyer2 });
    expect(await alertRow(blocked.id)).toMatchObject({ skip_reason: 'contact_blocked' });
    expect(await alertRow(optedOut.id)).toMatchObject({ skip_reason: 'opted_out' });
    expect((await alertRow(blocked.id)).notified_at).toBeNull();
    expect((await alertRow(fine.id)).notified_at).not.toBeNull();
  });

  it('sends the approved marketing template outside the window, and waits when there is none', async () => {
    const waiting = await claim(variants.template, 'late');
    // Their only message to the shop is two days old: the window is closed.
    await customerWrote('late', '2 days');
    await restock(variants.template, 2);
    expect(await handleBackInStockJob(account, { variantId: variants.template })).toEqual({ sent: 0, closed: 0, deferred: 1 });
    expect(await alertRow(waiting.id)).toMatchObject({ closed_at: null, notified_at: null, skip_reason: 'no_template' });
    expect(sends.text).not.toHaveBeenCalled();
    expect(sends.template).not.toHaveBeenCalled();

    // A utility template is refused for this kind; the marketing one is accepted and used.
    await expect(saveNoticeTemplate(asAdmin, { kind: 'back_in_stock', template: { name: 'bis_util', language: 'en' } })).rejects.toMatchObject({ code: 'wrong_category' });
    await saveNoticeTemplate(asAdmin, { kind: 'back_in_stock', template: { name: 'bis_offer', language: 'en' } });
    expect(await handleBackInStockJob(account, { variantId: variants.template })).toEqual({ sent: 1, closed: 0, deferred: 0 });
    expect(sends.template).toHaveBeenCalledTimes(1);
    const args = sends.template.mock.calls[0][0];
    expect(args).toMatchObject({ templateName: 'bis_offer', contactId: contacts.late });
    expect(JSON.stringify(args.params)).toContain(`/s/${handle}/p/${product}`);
    expect(await alertRow(waiting.id)).toMatchObject({ skip_reason: null });
    expect((await alertRow(waiting.id)).notified_at).not.toBeNull();
  });

  it('records an uncertain send for staff and never repeats it', async () => {
    const uncertain = await claim(variants.template, 'stranger');
    sends.text.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await handleBackInStockJob(account, { variantId: variants.template })).toEqual({ sent: 0, closed: 1, deferred: 0 });
    expect(await alertRow(uncertain.id)).toMatchObject({ skip_reason: 'outcome_unknown', notified_at: null });
    expect((await alertRow(uncertain.id)).closed_at).not.toBeNull();
    await handleBackInStockJob(account, { variantId: variants.template });
    expect(sends.text).toHaveBeenCalledTimes(1);
  });

  it('runs a long list in batches of 200', async () => {
    await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone,blocked_at)
      SELECT gen_random_uuid(),$1,$2,'Bulk '||g,'+1650'||lpad(g::text,7,'0'),now() FROM generate_series(1,201) g`, [account, owner]);
    await db.query(`INSERT INTO shop_stock_alerts(account_id,code,variant_id,contact_id,expires_at,claimed_at,claim_expires_at)
      SELECT $1,'ZZZZ'||substr('ABCDEFGHJKLMNPQRSTUVWXYZ',(row_number() OVER ())::int/24+1,1)||substr('ABCDEFGHJKLMNPQRSTUVWXYZ',(row_number() OVER ())::int%24+1,1),
        $2,c.id,now(),now(),now() + interval '90 days' FROM contacts c WHERE c.account_id=$1 AND c.name LIKE 'Bulk %'`, [account, variants.bulk]);
    await restock(variants.bulk, 1);
    expect(await handleBackInStockJob(account, { variantId: variants.bulk })).toEqual({ sent: 0, closed: 200, deferred: 0 });
    const next = (await db.query("SELECT dedupe_key, payload FROM jobs WHERE type='commerce.back_in_stock' AND dedupe_key LIKE $1", [`bis:${variants.bulk}:next:%`])).rows;
    expect(next).toHaveLength(1);
    expect(next[0].payload).toMatchObject({ variantId: variants.bulk });
    expect(await handleBackInStockJob(account, next[0].payload)).toEqual({ sent: 0, closed: 1, deferred: 0 });
    expect((await db.query('SELECT count(*)::int AS n FROM shop_stock_alerts WHERE variant_id=$1 AND closed_at IS NULL', [variants.bulk])).rows[0].n).toBe(0);
  });

  it('is written by the worker only, read by agents, and invisible to another workspace', async () => {
    // The app role (a staff browser session) cannot write alerts, whatever the member role.
    for (const ctx of [asAdmin, asAgent])
      await expect(withTenant(ctx, (tx) => tx.$executeRaw`INSERT INTO shop_stock_alerts(account_id,code,variant_id,expires_at)
        VALUES(${account}::uuid,${newCartCode()},${variants.main}::uuid,now())`)).rejects.toThrow();
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE shop_stock_alerts SET closed_at=now() WHERE account_id=${account}::uuid`)).rejects.toThrow();
    // The worker writes only inside its own workspace: another workspace's variant (key) or account_id (policy) is refused.
    await expect(worker((tx) => tx.$executeRaw`INSERT INTO shop_stock_alerts(account_id,code,variant_id,expires_at)
      VALUES(${account}::uuid,${newCartCode()},${variants.foreign}::uuid,now())`)).rejects.toThrow();
    await expect(worker((tx) => tx.$executeRaw`INSERT INTO shop_stock_alerts(account_id,code,variant_id,expires_at)
      VALUES(${other}::uuid,${newCartCode()},${variants.foreign}::uuid,now())`)).rejects.toThrow();

    // An agent sees how many people wait per variant on the product page; another workspace sees nothing of ours.
    const view = await withTenant(asAgent, (tx) => getShopProduct(tx, account, product));
    const waitingFor = (key: string) => view.variants.find((v) => v.id === variants[key])?.waiting;
    expect(waitingFor('main')).toBe(0);
    const open = await claim(variants.main, 'buyer2');
    expect(open.result).toMatchObject({ handled: true });
    expect(await withTenant(asAgent, async (tx) => (await getShopProduct(tx, account, product)).variants.find((v) => v.id === variants.main)?.waiting)).toBe(1);
    expect(await withTenant(asOther, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shop_stock_alerts`)).toEqual([{ n: 0 }]);
    expect(await withTenant(asAgent, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shop_stock_alerts`))
      .toEqual([{ n: Number((await db.query('SELECT count(*) AS n FROM shop_stock_alerts WHERE account_id=$1', [account])).rows[0].n) }]);
  });
});
