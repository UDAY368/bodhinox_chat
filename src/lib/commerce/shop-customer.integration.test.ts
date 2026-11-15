import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sendTemplate = vi.hoisted(() => vi.fn());
vi.mock('@/lib/whatsapp/meta-api', async (original) => ({
  ...(await original<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTemplateMessage: (...args: unknown[]) => sendTemplate(...args),
}));

import { disconnectDatabases } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { listAddressesTx, listOrdersTx, loadOrderDetailTx, readAsCustomer } from '@/lib/commerce/shop-customer';
import { CUSTOMER_COOKIE } from '@/lib/commerce/shop-customer-cookie';
import { POST as otpStart } from '@/app/api/public/store/[handle]/otp/route';
import { POST as otpVerify } from '@/app/api/public/store/[handle]/otp/verify/route';
import { POST as signInStart } from '@/app/s/[handle]/account/api/sign-in/route';
import { POST as signInVerify } from '@/app/s/[handle]/account/api/sign-in/verify/route';
import { POST as signOutRoute } from '@/app/s/[handle]/account/api/sign-out/route';
import { POST as addressesRoute } from '@/app/s/[handle]/account/api/addresses/route';
import { POST as reorderRoute } from '@/app/s/[handle]/account/api/reorder/route';
import { POST as checkoutRoute } from '@/app/s/[handle]/account/api/checkout/route';

// Customer accounts on the public shop (store plan Phase 5) on PostgreSQL:
// a session belongs to one shop and one contact, blocked contacts and
// expired or revoked sessions are refused, a buyer reads only their own
// orders and addresses, sign-in and checkout codes are not interchangeable,
// and "check out as" opens checkout only for the signed-in contact.
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

const A = randomUUID(), B = randomUUID(), owner = randomUUID();
const buyerX = randomUUID(), buyerY = randomUUID(), blocked = randomUUID(), later = randomUUID();
const orderX = randomUUID(), orderY = randomUUID(), product = randomUUID(), variant = randomUUID(), gone = randomUUID();
const number = randomUUID(), template = randomUUID();
const handleA = `p5a-${A.slice(0, 8)}`, handleB = `p5b-${B.slice(0, 8)}`;
// One number per buyer; the last eight digits are unique to this run.
const run = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
const phone = (n: number) => `9198${run}${String(n).padStart(2, '0')}`;
const PHONE_X = phone(1), PHONE_Y = phone(2), PHONE_BLOCKED = phone(3), PHONE_LATER = phone(4), PHONE_NEW = phone(5);
const ADDRESS = { name: 'Asha Rao', phone: '+919800000111', line1: '14 Temple Street', line2: null, city: 'Mysuru', state: 'Karnataka', state_code: 'KA',
  postal_code: '570001', country: 'IN', instructions: null };
let db: pg.Client;
let ip = 0;

const req = (body: unknown, options: { cookie?: string | null; origin?: string | null } = {}) => new Request(`${ORIGIN}/s/x/account/api/x`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${(ip++ % 200) + 1}`,
    ...(options.origin === null ? {} : { origin: options.origin ?? ORIGIN }),
    ...(options.cookie ? { cookie: options.cookie } : {}),
  },
  body: JSON.stringify(body),
});
const at = (h: string) => ({ params: Promise.resolve({ handle: h }) });
const lastCode = () => (sendTemplate.mock.calls.at(-1)![0] as { messageParams: { authCode: string } }).messageParams.authCode;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Sign in on shop A; answers the Cookie header a browser would send back, and the raw response. */
async function signIn(phoneDigits: string) {
  const started = await signInStart(req({ phone: `+${phoneDigits}` }), at(handleA));
  expect(started.status).toBe(200);
  const { challengeId } = await started.json();
  const response = await signInVerify(req({ challengeId, code: lastCode() }), at(handleA));
  const token = response.cookies.get(CUSTOMER_COOKIE)?.value ?? null;
  return { response, challengeId, token, cookie: token ? `${CUSTOMER_COOKIE}=${token}` : null };
}

/** A live session row for a contact on shop A, without spending the number's code allowance. */
async function seat(contactId: string) {
  const token = randomBytes(32).toString('base64url');
  await db.query("INSERT INTO shop_customer_sessions(account_id,contact_id,token_hash,expires_at) VALUES($1,$2,$3,now() + interval '30 days')",
    [A, contactId, sha256(token)]);
  return { token, cookie: `${CUSTOMER_COOKIE}=${token}` };
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('shop customer accounts on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const q = (sql: string, values: unknown[]) => db.query(sql, values);
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid,$2,'P5 accounts','test-only-hash')", [owner, `${owner}@example.invalid`]);
    for (const [id, name, handle] of [[A, 'Accounts A', handleA], [B, 'Accounts B', handleB]] as const) {
      await q('INSERT INTO accounts(id,name,owner_user_id) VALUES($1,$2,$3)', [id, name, owner]);
      await q("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [id]);
      await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [id, owner]);
      await q("INSERT INTO commerce_settings(account_id,currency,default_tax_rate_bps,checkout_enabled) VALUES($1,'INR',1800,true)", [id]);
      await q("INSERT INTO shop_storefronts(account_id,handle,published,template) VALUES($1,$2,true,'wellness')", [id, handle]);
    }
    await q(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,waba_id,access_token,status,is_default)
      VALUES($1,$2,$3,$4,'waba-p5',$5,'connected',true)`, [number, A, owner, `pn-${A.slice(0, 8)}`, encrypt('token-test')]);
    await q(`INSERT INTO message_templates(id,account_id,user_id,name,language,category,status,body_text,template_kind,waba_id)
      VALUES($1,$2,$3,'shop_code','en_US','Authentication','APPROVED','{{1}} is your code','authentication','waba-p5')`, [template, A, owner]);
    await q("UPDATE shop_storefronts SET whatsapp_config_id=$2, whatsapp_phone='919800000000', otp_template_id=$3 WHERE account_id=$1", [A, number, template]);
    await q(`INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES
      ($1,$5,$6,'Buyer X',$7),($2,$5,$6,'Buyer Y',$8),($3,$5,$6,'Blocked',$9),($4,$5,$6,'Blocked later',$10)`,
    [buyerX, buyerY, blocked, later, A, owner, PHONE_X, PHONE_Y, PHONE_BLOCKED, PHONE_LATER]);
    await q('UPDATE contacts SET blocked_at=now() WHERE id=$1', [blocked]);
    await q("INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Brahmi oil','published',now())", [product, A]);
    await q(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$3,$4,'BRA-1',25000),($2,$3,$4,'BRA-OLD',100)`, [variant, gone, A, product]);
    await q('UPDATE shop_variants SET archived_at=now() WHERE id=$1', [gone]);
    await q('INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,5)', [A, variant]);
    for (const [id, contact, total] of [[orderX, buyerX, 50100], [orderY, buyerY, 25000]] as const)
      await q(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,discount_minor,shipping_minor,tax_minor,tax_inclusive,total_minor,
          status,priced_at,payment_method)
        VALUES($1,$2,'storefront',$3,'INR',$4,0,0,0,true,$4,'paid',now(),'online')`, [id, A, contact, total]);
    await q(`INSERT INTO order_items(account_id,order_id,name,quantity,unit_price_minor,currency,variant_id) VALUES
      ($1,$2,'Brahmi oil',2,25000,'INR',$4),($1,$2,'Old sample',1,100,'INR',$5),($1,$3,'Secret Y item',1,25000,'INR',$4)`, [A, orderX, orderY, variant, gone]);
  });

  beforeEach(() => {
    sendTemplate.mockReset().mockResolvedValue({ messageId: `wamid.otp.${randomUUID()}` });
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[A, B]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[A, B]]);
      await db.query('DELETE FROM auth_users WHERE id=$1', [owner]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('signs a buyer in with a WhatsApp code: a scoped HttpOnly cookie, only a hash stored, and the code works once', async () => {
    const { response, challengeId, token } = await signIn(PHONE_X);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const header = response.headers.get('set-cookie') ?? '';
    expect(header).toContain(`Path=/s/${handleA}`);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=lax/i);
    expect(header).toMatch(/Max-Age=2592000/i);
    const row = (await db.query(`SELECT token_hash, contact_id::text, expires_at > now() + interval '29 days' AS long, revoked_at
      FROM shop_customer_sessions WHERE account_id=$1 AND contact_id=$2`, [A, buyerX])).rows[0];
    expect(row).toMatchObject({ token_hash: sha256(token!), contact_id: buyerX, long: true, revoked_at: null });
    expect(JSON.stringify(row)).not.toContain(token!);
    expect((await db.query('SELECT purpose, cart FROM shop_otp_challenges WHERE id=$1', [challengeId])).rows[0]).toEqual({ purpose: 'sign_in', cart: [] });
    // The same code a second time opens nothing.
    const again = await signInVerify(req({ challengeId, code: lastCode() }), at(handleA));
    expect(again.status).toBe(400);
    expect((await again.json()).code).toBe('otp_invalid');
    expect(again.cookies.get(CUSTOMER_COOKIE)).toBeUndefined();
    expect((await db.query('SELECT count(*)::int AS n FROM shop_customer_sessions WHERE account_id=$1 AND contact_id=$2', [A, buyerX])).rows[0].n).toBe(1);
    // A full number is never in the page data: the session shows a masked one.
    expect((await readAsCustomer(handleA, token, listAddressesTx))?.customer?.phoneMasked).toBe(`+91 ••••• •${PHONE_X.slice(-4)}`);
  });

  it('never lets a sign-in code open checkout, or a checkout code sign anyone in', async () => {
    const started = await signInStart(req({ phone: `+${PHONE_NEW}` }), at(handleA));
    const signInChallenge = (await started.json()).challengeId;
    const asCheckout = await otpVerify(req({ challengeId: signInChallenge, code: lastCode() }), at(handleA));
    expect(asCheckout.status).toBe(400);
    expect((await asCheckout.json()).code).toBe('otp_invalid');
    expect((await db.query('SELECT count(*)::int AS n FROM storefront_sessions WHERE account_id=$1', [A])).rows[0].n).toBe(0);

    const cartStart = await otpStart(req({ phone: `+${PHONE_NEW}`, cart: [{ variantId: variant, qty: 1 }] }), at(handleA));
    expect(cartStart.status).toBe(200);
    const checkoutChallenge = (await cartStart.json()).challengeId;
    const asSignIn = await signInVerify(req({ challengeId: checkoutChallenge, code: lastCode() }), at(handleA));
    expect(asSignIn.status).toBe(400);
    expect((await asSignIn.json()).code).toBe('otp_invalid');
    expect(asSignIn.cookies.get(CUSTOMER_COOKIE)).toBeUndefined();
    expect((await db.query('SELECT count(*)::int AS n FROM shop_customer_sessions s JOIN contacts c ON c.id=s.contact_id WHERE c.phone=$1', [PHONE_NEW])).rows[0].n).toBe(0);
    // Neither wrong-purpose try touched the other challenge.
    expect((await db.query('SELECT purpose, attempts, verified_at FROM shop_otp_challenges WHERE id=ANY($1::uuid[]) ORDER BY purpose', [[signInChallenge, checkoutChallenge]])).rows)
      .toEqual([{ purpose: 'checkout', attempts: 0, verified_at: null }, { purpose: 'sign_in', attempts: 0, verified_at: null }]);
  });

  it('refuses a session from shop A on shop B', async () => {
    const { cookie, token } = await seat(buyerX);
    expect((await readAsCustomer(handleA, token, listAddressesTx))?.customer?.contactId).toBe(buyerX);
    expect(await readAsCustomer(handleB, token, listAddressesTx)).toEqual({ customer: null });
    for (const call of [addressesRoute(req({ action: 'save', address: ADDRESS }, { cookie }), at(handleB)),
      reorderRoute(req({ orderId: orderX }, { cookie }), at(handleB)),
      checkoutRoute(req({ cart: [{ variantId: variant, qty: 1 }] }, { cookie }), at(handleB))]) {
      const res = await call;
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'signed_out' });
    }
    expect((await db.query('SELECT count(*)::int AS n FROM shop_customer_addresses WHERE account_id=$1', [B])).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM storefront_sessions WHERE account_id=$1', [B])).rows[0].n).toBe(0);
  });

  it('shows a buyer only their own orders and addresses', async () => {
    const x = await seat(buyerX), y = await seat(buyerY);
    const orders = await readAsCustomer(handleA, x.token, (tx, c) => listOrdersTx(tx, c, 1));
    expect(orders?.customer && orders.value.orders.map((o) => o.id)).toEqual([orderX]);
    expect(JSON.stringify(orders)).not.toContain(PHONE_X);
    const own = await readAsCustomer(handleA, x.token, (tx, c) => loadOrderDetailTx(tx, c, orderX));
    expect(own?.customer && own.value?.order.lines.map((l) => l.name).sort()).toEqual(['Brahmi oil', 'Old sample']);
    const foreign = await readAsCustomer(handleA, x.token, (tx, c) => loadOrderDetailTx(tx, c, orderY));
    expect(foreign?.customer && foreign.value).toBeNull();
    const reorderForeign = await reorderRoute(req({ orderId: orderY }, { cookie: x.cookie }), at(handleA));
    expect(reorderForeign.status).toBe(404);
    expect(JSON.stringify(await reorderForeign.json())).not.toContain('Secret');

    // Reorder: what is still on sale goes back to the cart, the archived variant is left out.
    const reorder = await reorderRoute(req({ orderId: orderX }, { cookie: x.cookie }), at(handleA));
    expect(await reorder.json()).toEqual({ lines: [{ variantId: variant, qty: 2 }], skipped: 1 });

    // Y saves an address; X cannot see, change, delete or check out with it.
    const saved = await addressesRoute(req({ action: 'save', address: { ...ADDRESS, name: 'Y Private' } }, { cookie: y.cookie }), at(handleA));
    expect(saved.status).toBe(200);
    const yAddress = (await saved.json()).addresses[0].id;
    expect((await readAsCustomer(handleA, x.token, listAddressesTx))).toMatchObject({ value: [] });
    const edit = await addressesRoute(req({ action: 'save', id: yAddress, address: { ...ADDRESS, name: 'Taken over' } }, { cookie: x.cookie }), at(handleA));
    expect(edit.status).toBe(404);
    const remove = await addressesRoute(req({ action: 'delete', id: yAddress }, { cookie: x.cookie }), at(handleA));
    expect(await remove.json()).toEqual({ addresses: [] });
    const checkout = await checkoutRoute(req({ cart: [{ variantId: variant, qty: 1 }], addressId: yAddress }, { cookie: x.cookie }), at(handleA));
    expect(checkout.status).toBe(400);
    expect((await db.query('SELECT name, contact_id::text FROM shop_customer_addresses WHERE id=$1', [yAddress])).rows[0]).toEqual({ name: 'Y Private', contact_id: buyerY });
    expect((await db.query('SELECT count(*)::int AS n FROM storefront_sessions WHERE account_id=$1 AND contact_id=$2', [A, buyerX])).rows[0].n).toBe(0);
  });

  it('refuses a blocked contact at sign-in and on every later read', async () => {
    const refused = await signIn(PHONE_BLOCKED);
    expect(refused.response.status).toBe(409);
    expect((await refused.response.json()).code).toBe('contact_blocked');
    expect(refused.token).toBeNull();
    expect((await db.query('SELECT count(*)::int AS n FROM shop_customer_sessions WHERE contact_id=$1', [blocked])).rows[0].n).toBe(0);

    const session = await signIn(PHONE_LATER);
    expect((await readAsCustomer(handleA, session.token, listAddressesTx))?.customer?.contactId).toBe(later);
    await db.query('UPDATE contacts SET blocked_at=now() WHERE id=$1', [later]);
    expect(await readAsCustomer(handleA, session.token, listAddressesTx)).toEqual({ customer: null });
    const res = await addressesRoute(req({ action: 'save', address: ADDRESS }, { cookie: session.cookie }), at(handleA));
    expect(res.status).toBe(401);
    expect((await checkoutRoute(req({ cart: [{ variantId: variant, qty: 1 }] }, { cookie: session.cookie }), at(handleA))).status).toBe(401);
  });

  it('refuses an expired session, and sign-out revokes the row and clears the cookie', async () => {
    const expired = await seat(buyerX);
    await db.query("UPDATE shop_customer_sessions SET expires_at=now() - interval '1 minute' WHERE token_hash=$1", [sha256(expired.token!)]);
    expect(await readAsCustomer(handleA, expired.token, listAddressesTx)).toEqual({ customer: null });
    expect((await reorderRoute(req({ orderId: orderX }, { cookie: expired.cookie }), at(handleA))).status).toBe(401);

    const live = await seat(buyerX);
    const out = await signOutRoute(req({}, { cookie: live.cookie }), at(handleA));
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toMatch(new RegExp(`${CUSTOMER_COOKIE}=;.*Path=/s/${handleA}.*Max-Age=0`, 'i'));
    expect((await db.query('SELECT revoked_at IS NOT NULL AS revoked FROM shop_customer_sessions WHERE token_hash=$1', [sha256(live.token!)])).rows[0].revoked).toBe(true);
    expect(await readAsCustomer(handleA, live.token, listAddressesTx)).toEqual({ customer: null });
    expect((await addressesRoute(req({ action: 'save', address: ADDRESS }, { cookie: live.cookie }), at(handleA))).status).toBe(401);
    // No cookie, a malformed one and an unknown one are all signed out.
    for (const cookie of [null, `${CUSTOMER_COOKIE}=nope`, `${CUSTOMER_COOKIE}=${'A'.repeat(43)}`])
      expect((await reorderRoute(req({ orderId: orderX }, { cookie }), at(handleA))).status).toBe(401);
  });

  it('keeps at most five saved addresses, validated like the checkout address', async () => {
    const { cookie } = await seat(buyerX);
    const bad = await addressesRoute(req({ action: 'save', address: { ...ADDRESS, postal_code: '' } }, { cookie }), at(handleA));
    expect(bad.status).toBe(400);
    expect((await addressesRoute(req({ action: 'drop' }, { cookie }), at(handleA))).status).toBe(400);
    let list: Array<{ id: string; name: string }> = [];
    for (let i = 1; i <= 5; i++) {
      const res = await addressesRoute(req({ action: 'save', address: { ...ADDRESS, name: `Home ${i}` } }, { cookie }), at(handleA));
      expect(res.status).toBe(200);
      list = (await res.json()).addresses;
    }
    expect(list.map((a) => a.name)).toEqual(['Home 1', 'Home 2', 'Home 3', 'Home 4', 'Home 5']);
    const sixth = await addressesRoute(req({ action: 'save', address: { ...ADDRESS, name: 'Home 6' } }, { cookie }), at(handleA));
    expect(sixth.status).toBe(409);
    expect((await sixth.json()).code).toBe('address_limit');
    // An edit is not an add, and a delete frees a place.
    const edited = await addressesRoute(req({ action: 'save', id: list[0].id, address: { ...ADDRESS, name: 'Office' } }, { cookie }), at(handleA));
    expect((await edited.json()).addresses[0]).toMatchObject({ id: list[0].id, name: 'Office', state_code: 'KA' });
    await addressesRoute(req({ action: 'delete', id: list[4].id }, { cookie }), at(handleA));
    expect((await addressesRoute(req({ action: 'save', address: { ...ADDRESS, name: 'Home 6' } }, { cookie }), at(handleA))).status).toBe(200);
    expect((await db.query('SELECT count(*)::int AS n FROM shop_customer_addresses WHERE account_id=$1 AND contact_id=$2', [A, buyerX])).rows[0].n).toBe(5);
  });

  it('opens checkout without a new code only for the signed-in contact, with the cart and a saved address', async () => {
    const cart = [{ variantId: variant, qty: 2 }];
    const anonymous = await checkoutRoute(req({ cart }), at(handleA));
    expect(anonymous.status).toBe(401);
    const { cookie, token } = await seat(buyerY);
    const address = (await readAsCustomer(handleA, token, listAddressesTx));
    const addressId = address?.customer ? address.value[0].id : null;
    expect(addressId).toBeTruthy();
    const res = await checkoutRoute(req({ cart, addressId }, { cookie }), at(handleA));
    expect(res.status).toBe(200);
    const { url } = await res.json();
    expect(url).toMatch(/\/shop\/[A-Za-z0-9_-]{43}$/);
    expect(sendTemplate).not.toHaveBeenCalled();
    const sessions = (await db.query(`SELECT contact_id::text, purpose, cart, address->>'name' AS name, address->>'postal_code' AS pin, token_hash
      FROM storefront_sessions WHERE account_id=$1 AND revoked_at IS NULL`, [A])).rows;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ contact_id: buyerY, purpose: 'shop', cart: [{ variant_id: variant, qty: 2 }], name: 'Y Private', pin: '570001',
      token_hash: sha256(url.split('/shop/')[1]) });
    // An item that is no longer on sale is refused, as from the code path.
    const stale = await checkoutRoute(req({ cart: [{ variantId: gone, qty: 1 }] }, { cookie }), at(handleA));
    expect((await stale.json()).code).toBe('variant_unavailable');
  });

  it('rejects another site, and keeps both tables away from staff browser sessions', async () => {
    const { cookie } = await seat(buyerY);
    const calls: Array<[(r: Request, c: ReturnType<typeof at>) => Promise<Response>, unknown]> = [
      [signInStart, { phone: `+${PHONE_Y}` }], [signInVerify, { challengeId: randomUUID(), code: '123456' }], [signOutRoute, {}],
      [addressesRoute, { action: 'save', address: ADDRESS }], [reorderRoute, { orderId: orderY }], [checkoutRoute, { cart: [{ variantId: variant, qty: 1 }] }],
    ];
    const before = (await db.query('SELECT count(*)::int AS n FROM shop_customer_addresses WHERE account_id=$1', [A])).rows[0].n;
    for (const [route, body] of calls) {
      for (const origin of ['https://evil.example', null]) {
        const res = await route(req(body, { cookie, origin }), at(handleA));
        expect(res.status).toBe(403);
      }
    }
    expect((await db.query('SELECT count(*)::int AS n FROM shop_customer_addresses WHERE account_id=$1', [A])).rows[0].n).toBe(before);
    // Still signed in: the cross-site sign-out changed nothing.
    expect((await reorderRoute(req({ orderId: orderY }, { cookie }), at(handleA))).status).toBe(200);
    // The app role (a staff browser session) cannot read sessions or saved addresses at all.
    await expect(withTenant({ accountId: A, userId: owner, role: 'owner' }, (tx) => tx.$queryRaw`SELECT count(*) FROM shop_customer_sessions`)).rejects.toThrow();
    await expect(withTenant({ accountId: A, userId: owner, role: 'owner' }, (tx) => tx.$queryRaw`SELECT count(*) FROM shop_customer_addresses`)).rejects.toThrow();
  });
});
