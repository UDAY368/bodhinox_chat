import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectDatabases } from '@/lib/db/prisma';
import { loadBoughtTogether, loadShopProduct, inShopTenant } from '@/lib/commerce/public-shop';
import { createNewArrivalsCampaign } from '@/lib/commerce/new-arrivals';

// "Often bought together" and "Send as new arrivals" (store plan Phase 3) on
// PostgreSQL. Suggestions come from real sales of this workspace only, for
// published sellable products, and cancelled or old orders do not count. The
// new-arrivals campaign refuses foreign or unpublished products, unapproved
// or mismatched templates and unpublished shops, and otherwise goes through
// the ordinary campaign path (recipients, frozen values, one durable job).
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL = 'https://app.example.test';

const account = randomUUID(), other = randomUUID(), owner = randomUUID(), viewer = randomUUID(), contact = randomUUID();
const ids = Object.fromEntries(['a', 'b', 'c', 'd', 'draft', 'noimg', 'foreign'].map((k) => [k, randomUUID()])) as Record<string, string>;
const variants = Object.fromEntries(Object.keys(ids).map((k) => [k, randomUUID()])) as Record<string, string>;
const handle = `p3a-${account.slice(0, 8)}`;
const tplCarousel2 = randomUUID(), tplPending = randomUUID(), tplCarousel3 = randomUUID(), tplForeign = randomUUID();
const agent = { accountId: account, userId: owner, role: 'agent' as const };
let db: pg.Client;

const card = { header_type: 'image', header_media_url: 'https://cdn.test/s.png', body_text: '{{1}} for {{2}}',
  buttons: [{ type: 'URL', text: 'View', url: 'https://shop.test/s/x/{{1}}', example: 'https://shop.test/s/x/p/1' }] };
const campaign = (over: Record<string, unknown> = {}) => ({
  name: `Arrivals ${randomUUID()}`, templateId: tplCarousel2, productIds: [ids.a, ids.b], audience: { type: 'all' }, bodyValues: ['Ana'], ...over,
});

async function order(status: string, products: string[], opts: { cod?: boolean; ageDays?: number } = {}) {
  const id = randomUUID();
  await db.query(`INSERT INTO orders(id,account_id,source,currency,subtotal_minor,status,payment_method,created_at)
    VALUES($1,$2,'manual','INR',100,$3,$4, now() - ($5 || ' days')::interval)`, [id, account, status, opts.cod ? 'cod' : 'online', String(opts.ageDays ?? 1)]);
  for (const p of products) {
    await db.query(`INSERT INTO order_items(account_id,order_id,name,quantity,unit_price_minor,currency,variant_id) VALUES($1,$2,'x',1,100,'INR',$3)`, [account, id, variants[p]]);
  }
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('often bought together and new arrivals on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const q = (sql: string, values: unknown[]) => db.query(sql, values);
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid,$2,'P3a owner','test-only-hash'),($3::uuid,$4,'P3a viewer','test-only-hash')",
      [owner, `${owner}@example.invalid`, viewer, `${viewer}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P3a shop',$3),($2,'P3a other',$3)", [account, other, owner]);
    await q("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [account, other]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$3,'agent'),($1,$4,'viewer'),($2,$3,'owner')", [account, other, owner, viewer]);
    await q("INSERT INTO commerce_settings(account_id,currency,default_tax_rate_bps,checkout_enabled) VALUES($1,'INR',1800,true),($2,'INR',1800,true)", [account, other]);
    await q("INSERT INTO shop_storefronts(account_id,handle,published,template) VALUES($1,$2,true,'wellness')", [account, handle]);
    await q(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES
      ($1,$8,'Alpha','published',now()),($2,$8,'Beta','published',now()),($3,$8,'Gamma','published',now()),($4,$8,'Delta','published',now()),
      ($5,$8,'Draft one','draft',now()),($6,$8,'No image','published',now()),($7,$9,'Foreign','published',now())`,
    [ids.a, ids.b, ids.c, ids.d, ids.draft, ids.noimg, ids.foreign, account, other]);
    for (const k of Object.keys(ids)) {
      await q('INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory) VALUES($1,$2,$3,$4,25000,false)', [variants[k], k === 'foreign' ? other : account, ids[k], `P3A-${k}`]);
    }
    for (const k of ['a', 'b', 'c', 'd', 'draft', 'foreign']) {
      await q("INSERT INTO shop_product_images(account_id,product_id,url,position) VALUES($1,$2,$3,0)", [k === 'foreign' ? other : account, ids[k], `https://cdn.example.com/${k}.png`]);
    }
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Asha','14155550123')", [contact, account, owner]);
    await q(`INSERT INTO message_templates(id,account_id,user_id,name,body_text,status,template_kind,cards) VALUES
      ($1,$5,$6,'arrivals_two','New in, {{1}}','APPROVED','carousel',$7::jsonb),
      ($2,$5,$6,'arrivals_pending','New in, {{1}}','PENDING','carousel',$7::jsonb),
      ($3,$5,$6,'arrivals_three','New in, {{1}}','APPROVED','carousel',$8::jsonb),
      ($4,$9,$6,'arrivals_foreign','New in, {{1}}','APPROVED','carousel',$7::jsonb)`,
    [tplCarousel2, tplPending, tplCarousel3, tplForeign, account, owner, JSON.stringify([card, card]), JSON.stringify([card, card, card]), other]);

    // Sales: a with b three times, a with c once (paid), a with d only on a cancelled order, a with draft and with noimg.
    await order('paid', ['a', 'b']);
    await order('fulfilled', ['a', 'b']);
    await order('confirmed', ['a', 'b'], { cod: true });
    await order('paid', ['a', 'c']);
    await order('cancelled', ['a', 'd']);
    await order('cancelled', ['a', 'd']);
    await order('paid', ['a', 'draft']);
    await order('confirmed', ['a', 'noimg']); // confirmed but not COD: not a real sale yet
    await order('paid', ['a', 'd'], { ageDays: 400 }); // too old
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[owner, viewer]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('ranks products bought with this one by shared real sales, ignoring cancelled, old, draft and unpaid orders', async () => {
    const page = await loadShopProduct(handle, ids.a);
    expect(page?.togetherIsRelated).toBe(false);
    expect(page?.boughtTogether.map((p) => p.id)).toEqual([ids.b, ids.c]);
    // Only the public product shape: no counts or order ids.
    const json = JSON.stringify(page?.boughtTogether);
    expect(json).not.toMatch(/count|order/i);
    expect(Object.keys(page!.boughtTogether[0]).sort()).toEqual(['categoryId', 'categoryName', 'description', 'details', 'disclosure', 'id', 'images', 'name', 'rating', 'variants']);
  });

  it('falls back to the same-category products when fewer than two products share sales', async () => {
    const page = await loadShopProduct(handle, ids.c);
    expect(page?.togetherIsRelated).toBe(true);
    expect(page?.boughtTogether).toEqual(page?.related);
  });

  it('suggests for a whole cart without the cart\'s own products, never from another workspace', async () => {
    const mine = await inShopTenant(account, (tx) => loadBoughtTogether(tx, account, handle, [ids.a, ids.b]));
    expect(mine.map((p) => p.id)).toEqual([ids.c]);
    // The other workspace has no sales: asking with this workspace's product ids finds nothing there.
    const theirs = await inShopTenant(other, (tx) => loadBoughtTogether(tx, other, 'x', [ids.a]));
    expect(theirs).toEqual([]);
    expect(await inShopTenant(account, (tx) => loadBoughtTogether(tx, account, handle, []))).toEqual([]);
  });

  it('starts the campaign through the ordinary path: one recipient, frozen card values, one durable job', async () => {
    const result = await createNewArrivalsCampaign(agent, campaign());
    const [b] = (await db.query('SELECT total_recipients, status, template_variables FROM broadcasts WHERE id=$1', [result.id])).rows;
    expect(b).toMatchObject({ total_recipients: 1, status: 'sending' });
    expect(b.template_variables).toMatchObject({
      '1': { type: 'static', value: 'Ana' }, c1_1: { type: 'static', value: 'Alpha' }, c2_1: { type: 'static', value: 'Beta' },
      _send: { cards: [
        { headerMediaUrl: expect.stringMatching(new RegExp(`^https://app\\.example\\.test/api/public/store/${handle}/images/`)), buttonParams: { 0: `p/${ids.a}` } },
        { headerMediaUrl: expect.stringContaining('/images/'), buttonParams: { 0: `p/${ids.b}` } },
      ] },
    });
    const recipients = (await db.query('SELECT contact_id, template_params FROM broadcast_recipients WHERE broadcast_id=$1', [result.id])).rows;
    expect(recipients).toHaveLength(1);
    expect(recipients[0].contact_id).toBe(contact);
    expect(recipients[0].template_params[0]).toBe('Ana');
    const jobs = (await db.query('SELECT status FROM jobs WHERE dedupe_key=$1', [`broadcast:${result.id}:initial`])).rows;
    expect(jobs).toEqual([{ status: 'pending' }]);
  });

  it('never reaches an opted-out contact (the wizard\'s consent rule)', async () => {
    await db.query('UPDATE contacts SET opted_out_at=now() WHERE id=$1', [contact]);
    try {
      await expect(createNewArrivalsCampaign(agent, campaign())).rejects.toMatchObject({ status: 400 });
    } finally {
      await db.query('UPDATE contacts SET opted_out_at=NULL WHERE id=$1', [contact]);
    }
  });

  it('refuses foreign, draft and image-less products, and a repeated product, before creating anything', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM broadcasts WHERE account_id=$1', [account])).rows[0].n;
    await expect(createNewArrivalsCampaign(agent, campaign({ productIds: [ids.a, ids.foreign] }))).rejects.toMatchObject({ status: 400, code: 'products_unavailable' });
    await expect(createNewArrivalsCampaign(agent, campaign({ productIds: [ids.a, ids.draft] }))).rejects.toMatchObject({ code: 'products_unavailable' });
    await expect(createNewArrivalsCampaign(agent, campaign({ productIds: [ids.a, ids.noimg] }))).rejects.toMatchObject({ code: 'product_no_image' });
    await expect(createNewArrivalsCampaign(agent, campaign({ productIds: [ids.a, ids.a] }))).rejects.toMatchObject({ status: 400 });
    expect((await db.query('SELECT count(*)::int AS n FROM broadcasts WHERE account_id=$1', [account])).rows[0].n).toBe(before);
  });

  it('refuses an unapproved, foreign or wrongly sized template, and missing message values', async () => {
    await expect(createNewArrivalsCampaign(agent, campaign({ templateId: tplPending }))).rejects.toMatchObject({ status: 400 });
    await expect(createNewArrivalsCampaign(agent, campaign({ templateId: tplForeign }))).rejects.toMatchObject({ status: 404 });
    await expect(createNewArrivalsCampaign(agent, campaign({ templateId: tplCarousel3 }))).rejects.toMatchObject({ status: 400 });
    await expect(createNewArrivalsCampaign(agent, campaign({ bodyValues: [] }))).rejects.toMatchObject({ code: 'body_values' });
  });

  it('refuses a viewer, and an unpublished shop', async () => {
    await expect(createNewArrivalsCampaign({ ...agent, userId: viewer, role: 'viewer' }, campaign())).rejects.toMatchObject({ status: 403 });
    // A viewer id carrying an agent role is still refused: the live membership decides.
    await expect(createNewArrivalsCampaign({ ...agent, userId: viewer }, campaign())).rejects.toMatchObject({ status: 403 });
    await db.query('UPDATE shop_storefronts SET published=false WHERE account_id=$1', [account]);
    try {
      await expect(createNewArrivalsCampaign(agent, campaign())).rejects.toMatchObject({ code: 'shop_not_published' });
    } finally {
      await db.query('UPDATE shop_storefronts SET published=true WHERE account_id=$1', [account]);
    }
  });
});

