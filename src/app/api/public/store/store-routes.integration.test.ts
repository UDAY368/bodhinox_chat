import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sendTemplate = vi.hoisted(() => vi.fn());
const sendText = vi.hoisted(() => vi.fn());
vi.mock('@/lib/whatsapp/meta-api', async (original) => ({
  ...(await original<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTemplateMessage: (...args: unknown[]) => sendTemplate(...args),
  sendTextMessage: (...args: unknown[]) => sendText(...args),
}));

import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { handleShopCartCode, loadShopCategory, loadShopHome, loadShopProduct, resolvePublicShop } from '@/lib/commerce/public-shop';
import { getShopSite, parseShopSiteInput, saveShopSite } from '@/lib/commerce/shop-site';
import { POST as previewCart } from './[handle]/cart/route';
import { POST as otpStart } from './[handle]/otp/route';
import { POST as otpVerify } from './[handle]/otp/verify/route';
import { POST as waOrder } from './[handle]/whatsapp/route';
import { GET as image } from './[handle]/images/[imageId]/route';
import { GET as media } from './[handle]/media/[mediaId]/route';

// The public shop (store plan Phase 1) end to end on PostgreSQL: handle
// resolution through the definer (published shops only), tenancy of every
// read, Origin checks, the WhatsApp code path into an ordinary storefront
// session, and the "ORDER <CODE>" path claimed by the sender only.
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

const account = randomUUID(), other = randomUUID(), owner = randomUUID();
const product = randomUUID(), draft = randomUUID(), variant = randomUUID(), archived = randomUUID(), draftVariant = randomUUID();
const foreignProduct = randomUUID(), foreignVariant = randomUUID(), category = randomUUID(), child = randomUUID(), childProduct = randomUUID();
const childVariant = randomUUID(), number = randomUUID(), template = randomUUID(), logo = randomUUID(), secretMedia = randomUUID();
const draftImage = randomUUID(), buyer = randomUUID(), stranger = randomUUID(), conversation = randomUUID(), strangerConversation = randomUUID();
const handle = `p1-${account.slice(0, 8)}`, otherHandle = `p1-${other.slice(0, 8)}`;
let db: pg.Client;
let ip = 0;

const req = (body?: unknown, origin: string | null = ORIGIN) => new Request(`${ORIGIN}/api/public/store/x`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), 'x-forwarded-for': `198.51.100.${(ip++ % 200) + 1}` },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const at = (h: string) => ({ params: Promise.resolve({ handle: h }) });

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('public shop on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const q = (sql: string, values: unknown[]) => db.query(sql, values);
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid,$2,'P1 shop','test-only-hash')", [owner, `${owner}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P1 Ayurveda',$3),($2,'P1 other',$3)", [account, other, owner]);
    await q("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [account, other]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$3,'owner'),($2,$3,'owner')", [account, other, owner]);
    await q("INSERT INTO commerce_settings(account_id,currency,default_tax_rate_bps,checkout_enabled) VALUES($1,'INR',1800,true),($2,'INR',1800,true)", [account, other]);
    await q("INSERT INTO shop_categories(id,account_id,name,position) VALUES($1,$3,'Oils',1),($2,$3,'Hair oils',2)", [category, child, account]);
    await q('UPDATE shop_categories SET parent_id=$1 WHERE id=$2', [category, child]);
    await q(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at,category_id) VALUES
      ($1,$4,'Brahmi oil','published',now(),$5),($2,$4,'Secret draft','draft',now(),$5),($3,$4,'Bhringraj oil','published',now(),$6)`,
    [product, draft, childProduct, account, category, child]);
    await q("INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Foreign','published',now())", [foreignProduct, other]);
    await q(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,option_values) VALUES
      ($1,$5,$6,'BRA-100',25000,'{"Size":"100ml"}'),($2,$5,$6,'BRA-OLD',100,'{"Size":"1ml"}'),($3,$5,$7,'DRAFT-1',999,'{}'),($4,$5,$8,'BHR-1',45000,'{"Size":"200ml"}')`,
    [variant, archived, draftVariant, childVariant, account, product, draft, childProduct]);
    await q('UPDATE shop_variants SET archived_at=now() WHERE id=$1', [archived]);
    await q("INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'FOR-1',100)", [foreignVariant, other, foreignProduct]);
    await q("INSERT INTO shop_product_images(id,account_id,product_id,url,position) VALUES($1,$2,$3,'https://cdn.example.com/draft.png',0)", [draftImage, account, draft]);
    await q(`INSERT INTO media_objects(id,account_id,uploaded_by,object_key,bucket,content_type,byte_size,original_name,in_library) VALUES
      ($1,$3,$4,'p1/logo.png','chat-media','image/png',10,'logo.png',true),($2,$3,$4,'p1/secret.png','chat-media','image/png',10,'secret.png',true)`,
    [logo, secretMedia, account, owner]);
    await q(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,waba_id,access_token,status,is_default)
      VALUES($1,$2,$3,$4,'waba-p1',$5,'connected',true)`, [number, account, owner, `pn-${account.slice(0, 8)}`, encrypt('token-test')]);
    await q(`INSERT INTO message_templates(id,account_id,user_id,name,language,category,status,body_text,template_kind,waba_id)
      VALUES($1,$2,$3,'shop_code','en_US','Authentication','APPROVED','{{1}} is your code','authentication','waba-p1')`, [template, account, owner]);
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$3,$4,'Buyer','919800000001'),($2,$3,$4,'Stranger','919800000002')",
      [buyer, stranger, account, owner]);
    await q('INSERT INTO conversations(id,account_id,user_id,contact_id,whatsapp_config_id) VALUES($1,$3,$4,$5,$6),($2,$3,$4,$7,$6)',
      [conversation, strangerConversation, account, owner, buyer, number, stranger]);
    await q("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id) VALUES($1,$2,'customer','text','hi','wamid.p1a'),($1,$3,'customer','text','hi','wamid.p1b')",
      [account, conversation, strangerConversation]);
    await q(`INSERT INTO shop_storefronts(account_id,handle,published,template,theme,whatsapp_config_id,whatsapp_phone,otp_template_id)
      VALUES($1,$2,true,'wellness',$3::jsonb,$4,'919800000000',$5),($6,$7,false,'fashion','{}',NULL,NULL,NULL)`,
    [account, handle, JSON.stringify({ logo: `media:${logo}` }), number, template, other, otherHandle]);
  });

  beforeEach(() => {
    sendTemplate.mockReset().mockResolvedValue({ messageId: `wamid.otp.${randomUUID()}` });
    sendText.mockReset().mockResolvedValue({ messageId: `wamid.txt.${randomUUID()}` });
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

  it('resolves only published shops, and an unpublished one is the plain 404', async () => {
    expect(await resolvePublicShop(handle)).toBe(account);
    expect(await resolvePublicShop(otherHandle)).toBeNull();
    expect(await resolvePublicShop("x' OR true --")).toBeNull();
    expect(await loadShopHome(otherHandle)).toBeNull();
    const res = await previewCart(req({ lines: [{ variantId: foreignVariant, qty: 1 }] }), at(otherHandle));
    expect(res.status).toBe(404);
  });

  it('shows only published, priced, live products of its own workspace, and no customer data', async () => {
    const home = await loadShopHome(handle);
    expect(home?.featured.map((p) => p.id).sort()).toEqual([product, childProduct].sort());
    expect(home?.featured.find((p) => p.id === product)?.variants.map((v) => v.id)).toEqual([variant]);
    expect(home?.shop.logoUrl).toBe(`/api/public/store/${handle}/media/${logo}`);
    const text = JSON.stringify(home);
    for (const secret of ['Secret draft', 'Foreign', '919800000001', 'token-test', 'waba-p1', template, number, account]) expect(text).not.toContain(secret);
    expect(await loadShopProduct(handle, draft)).toBeNull();
    expect(await loadShopProduct(handle, foreignProduct)).toBeNull();
    expect((await loadShopProduct(handle, product))?.product.name).toBe('Brahmi oil');
  });

  it('lists a category with its sub-category, sorted and filtered on the server', async () => {
    const page = await loadShopCategory(handle, category, { sort: 'price_desc' });
    expect(page?.products.map((p) => p.id)).toEqual([childProduct, product]);
    expect(page?.children.map((c) => c.id)).toEqual([child]);
    expect(page?.options).toEqual({ Size: ['100ml', '200ml'] });
    expect((await loadShopCategory(handle, category, { max: '300' }))?.products.map((p) => p.id)).toEqual([product]);
    expect((await loadShopCategory(handle, category, { option: 'Size:200ml' }))?.products.map((p) => p.id)).toEqual([childProduct]);
    expect(await loadShopCategory(otherHandle, category)).toBeNull();
  });

  it('prices the browser cart from the database and drops what is not on sale', async () => {
    expect((await previewCart(req({ lines: [{ variantId: variant, qty: 1 }] }, 'https://evil.example'), at(handle))).status).toBe(403);
    const res = await previewCart(req({ lines: [{ variantId: variant, qty: 2 }, { variantId: foreignVariant, qty: 1 },
      { variantId: archived, qty: 1 }, { variantId: draftVariant, qty: 1 }] }), at(handle));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toMatchObject([{ variantId: variant, qty: 2, unitPriceMinor: 25000, lineTotalMinor: 50000 }]);
    expect(body.removed.sort()).toEqual([foreignVariant, archived, draftVariant].sort());
    expect(body.subtotalMinor).toBe(50000);
    expect((await previewCart(req({ lines: 'nope' }), at(handle))).status).toBe(400);
  });

  it('serves only theme media and images of published products', async () => {
    const get = (fn: typeof media, params: Record<string, string>) => fn(req(), { params: Promise.resolve({ handle, ...params }) } as never);
    // A library file the theme does not name stays private, and so does a draft product's image.
    expect((await get(media, { mediaId: secretMedia })).status).toBe(404);
    expect((await get(image as never, { imageId: draftImage })).status).toBe(404);
    const otherShop = await media(req(), { params: Promise.resolve({ handle: otherHandle, mediaId: logo }) });
    expect(otherShop.status).toBe(404);
  });

  it('opens checkout with a WhatsApp code: one send, five tries, a contact and a session holding the cart', async () => {
    const cart = [{ variantId: variant, qty: 3 }];
    expect((await otpStart(req({ phone: '9876543210', cart }), at(handle))).status).toBe(400);
    const started = await otpStart(req({ phone: '+91 98111 22233', cart }), at(handle));
    expect(started.status).toBe(200);
    const { challengeId } = await started.json();
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    const sent = sendTemplate.mock.calls[0][0] as { to: string; templateName: string; messageParams: { authCode: string } };
    expect(sent).toMatchObject({ to: '919811122233', templateName: 'shop_code' });
    const code = sent.messageParams.authCode;
    // Only an HMAC is stored, never the code.
    const stored = (await db.query('SELECT code_hash, phone FROM shop_otp_challenges WHERE id=$1', [challengeId])).rows[0];
    expect(stored.phone).toBe('+919811122233');
    expect(stored.code_hash).not.toContain(code);

    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await otpVerify(req({ challengeId, code: wrong }), at(handle));
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('otp_invalid');
    // Another shop's handle never reaches this challenge.
    expect((await otpVerify(req({ challengeId, code }), at(otherHandle))).status).toBe(404);

    const ok = await otpVerify(req({ challengeId, code }), at(handle));
    expect(ok.status).toBe(200);
    const { url } = await ok.json();
    expect(url).toMatch(/\/shop\/[A-Za-z0-9_-]{43}$/);
    const session = (await db.query(`SELECT s.cart, s.purpose, c.phone FROM storefront_sessions s JOIN contacts c ON c.id=s.contact_id
      WHERE s.account_id=$1 AND s.id=(SELECT session_id FROM shop_otp_challenges WHERE id=$2)`, [account, challengeId])).rows[0];
    expect(session).toMatchObject({ purpose: 'shop', phone: '919811122233', cart: [{ variant_id: variant, qty: 3 }] });
    // A replay answers the same link; no second send.
    expect((await (await otpVerify(req({ challengeId, code }), at(handle))).json()).url).toBe(url);
    expect(sendTemplate).toHaveBeenCalledTimes(1);

    // A second challenge locks after five wrong tries.
    const second = await (await otpStart(req({ phone: '+91 98111 22244', cart }), at(handle))).json();
    for (let i = 0; i < 5; i++) await otpVerify(req({ challengeId: second.challengeId, code: wrong }), at(handle));
    const locked = await otpVerify(req({ challengeId: second.challengeId, code: (sendTemplate.mock.calls[1][0] as typeof sent).messageParams.authCode }), at(handle));
    expect((await locked.json()).code).toBe('otp_locked');
  });

  it('refuses a code request when the shop has no approved authentication template', async () => {
    await db.query("UPDATE message_templates SET status='PENDING' WHERE id=$1", [template]);
    try {
      const res = await otpStart(req({ phone: '+91 98111 22255', cart: [{ variantId: variant, qty: 1 }] }), at(handle));
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('otp_unavailable');
      expect(sendTemplate).not.toHaveBeenCalled();
    } finally {
      await db.query("UPDATE message_templates SET status='APPROVED' WHERE id=$1", [template]);
    }
  });

  it('saves an "Order on WhatsApp" cart and gives it only to the first sender of its code', async () => {
    const res = await waOrder(req({ cart: [{ variantId: variant, qty: 1 }] }), at(handle));
    expect(res.status).toBe(200);
    const { code, whatsappUrl } = await res.json();
    expect(whatsappUrl).toMatch(/^https:\/\/wa\.me\/919800000000\?text=/);
    expect(decodeURIComponent(whatsappUrl.split('text=')[1]).endsWith(`ORDER ${code}`)).toBe(true);

    // A code of this workspace means nothing in another one.
    expect(await handleShopCartCode({ accountId: other, contactId: buyer, conversationId: conversation, whatsappConfigId: null, code }))
      .toMatchObject({ handled: false });
    const first = await handleShopCartCode({ accountId: account, contactId: buyer, conversationId: conversation, whatsappConfigId: number, code });
    expect(first).toEqual({ handled: true, outcome: 'sent' });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(String((sendText.mock.calls[0][0] as { text: string }).text)).toMatch(/\/shop\/[A-Za-z0-9_-]{43}/);
    const claimed = (await db.query(`SELECT c.contact_id, s.cart FROM shop_cart_codes c JOIN storefront_sessions s ON s.id=c.session_id
      WHERE c.account_id=$1 AND c.code=$2`, [account, code])).rows[0];
    expect(claimed).toMatchObject({ contact_id: buyer, cart: [{ variant_id: variant, qty: 1 }] });
    // The same sender again (a retried job) sends nothing new; someone else gets ordinary text.
    expect(await handleShopCartCode({ accountId: account, contactId: buyer, conversationId: conversation, whatsappConfigId: number, code }))
      .toEqual({ handled: true, outcome: 'sent' });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(await handleShopCartCode({ accountId: account, contactId: stranger, conversationId: strangerConversation, whatsappConfigId: number, code }))
      .toMatchObject({ handled: false, outcome: 'code_unknown' });
  });

  it('keeps one-time codes away from browser sessions and settings writes to admins', async () => {
    // The app role (a staff browser session) has no access to one-time code challenges at all.
    await expect(withTenant({ accountId: account, userId: owner, role: 'owner' }, (tx) =>
      tx.$queryRaw`SELECT count(*) FROM shop_otp_challenges`)).rejects.toThrow();
    // An agent reads the settings but cannot write them (RLS), and the worker cannot write them either.
    const view = await getShopSite({ accountId: account, userId: owner, role: 'agent' });
    expect(view.site).toMatchObject({ saved: true, handle, published: true });
    const input = parseShopSiteInput({ expectedVersion: view.site.version, handle, published: false, template: 'food', theme: {} });
    await expect(saveShopSite({ accountId: account, userId: owner, role: 'agent' }, input)).rejects.toThrow();
    await expect(withTenant({ accountId: account, role: 'owner' }, (tx) =>
      tx.$executeRaw`UPDATE shop_storefronts SET published=false WHERE account_id=${account}::uuid`, getWorkerPrisma())).rejects.toThrow();
    expect(await resolvePublicShop(handle)).toBe(account);
  });

  it('saves version-checked settings and refuses a handle another workspace holds', async () => {
    const ctx = { accountId: account, userId: owner, role: 'admin' as const };
    const view = await getShopSite(ctx);
    const base = { handle, published: true, template: 'grocery', theme: { colors: { primary: '#112233' } },
      whatsappConfigId: number, whatsappPhone: '919800000000', otpTemplateId: template };
    await expect(saveShopSite(ctx, parseShopSiteInput({ ...base, expectedVersion: view.site.version + 5 }))).rejects.toMatchObject({ code: 'conflict' });
    await expect(saveShopSite(ctx, parseShopSiteInput({ ...base, handle: otherHandle, expectedVersion: view.site.version })))
      .rejects.toMatchObject({ code: 'handle_taken' });
    const saved = await saveShopSite(ctx, parseShopSiteInput({ ...base, expectedVersion: view.site.version }));
    expect(saved.site).toMatchObject({ template: 'grocery', version: view.site.version + 1, theme: { colors: { primary: '#112233' } } });
    expect(saved.checklist.find((i) => i.key === 'ordering')?.done).toBe(true);
    const audit = (await db.query("SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='commerce.shop_site_updated' ORDER BY created_at DESC LIMIT 1", [account])).rows[0];
    expect(audit.metadata.fields).toEqual(expect.arrayContaining(['template', 'theme']));
    expect(JSON.stringify(audit.metadata)).not.toContain('#112233');
  });
});
