import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Page, type Route } from '@playwright/test';
import { login } from './fixtures';
import { removeWorkspaces, seedWorkspace, withDb, type Workspace } from './journeys';
import { deriveStorefrontToken, storefrontTokenHash } from '../src/lib/commerce/storefront-token';
import { orderTrackingToken } from '../src/lib/commerce/order-tracking-token';

// Store batch 6: a buyer's walk through the public themed shop (/s/<handle>) at phone width, on the real app.
// Its own workspace: a published, open shop (INR, checkout on, one IN shipping rate, an "Order on WhatsApp" number),
// two categories, 31 live products (one with a 2x2 option matrix that has a sold-out combination and a low-stock one),
// a placed order to track, and a second workspace whose checkout link must not open on this shop.
// Nothing is paid and nothing is sent: wa.me navigations are answered locally.

const SHOTS = process.env.STORE_JOURNEY_SHOTS
  || 'C:\\Users\\uday\\AppData\\Local\\Temp\\claude\\d4b95d3a2ba16373\\2ca93409-144a-41e5-97ac-0a02ececdb34\\scratchpad\\journey';
// A 1x1 pixel (product images are https URLs the image route redirects to; answered here, never fetched).
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const IMAGE_HOST = 'https://img.e2e.invalid';

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

interface Seed {
  a: Workspace; b: Workspace; handle: string; run: string;
  hero: { id: string; slug: string; name: string };
  cached: { id: string; slug: string; name: string };
  checkoutToken: string; otherToken: string; trackingToken: string; orderItem: string;
}
let seed: Seed;
const timings: Array<{ page: string; first: number; cached: number }> = [];

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

/** Horizontal overflow and visible tap targets under 44px, logged for the report (never failed on). */
async function layoutReport(page: Page, label: string) {
  const report = await page.evaluate(() => {
    const doc = document.documentElement;
    const small: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('main a, main button, main input, main select, header a, header button'))) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
      // An inline text link inside a sentence is not a tap target of its own.
      if (el.tagName === 'A' && getComputedStyle(el).display === 'inline' && el.closest('p, li, nav[aria-label]')) continue;
      if (r.height < 44 || r.width < 44) {
        small.push(`${el.tagName.toLowerCase()}"${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return { overflow: doc.scrollWidth > doc.clientWidth ? `${doc.scrollWidth}>${doc.clientWidth}` : null, small: [...new Set(small)].slice(0, 15) };
  });
  console.log(`[layout] ${label}: overflow=${report.overflow ?? 'none'}; small targets=${report.small.length ? report.small.join(' | ') : 'none'}`);
}

/** Server response time of the current document: responseStart - requestStart (ms). */
const serverTime = (page: Page) => page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
  return Math.round(nav.responseStart - nav.requestStart);
});

async function staffWrite(page: Page, method: 'PATCH' | 'POST', url: string, data: unknown) {
  await page.request.get('/api/auth/csrf');
  const csrf = (await page.context().cookies()).find((c) => c.name === '__Host-bnx_csrf' || c.name === 'bnx_csrf');
  const origin = new URL(page.url()).origin;
  return page.request.fetch(url, { method, headers: { origin, 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') }, data });
}

/** The real image route answers a stored https image with a 302; a redirect target is not routed by Playwright, so the
 * redirect is read here (maxRedirects 0) and its target answered with a pixel. */
async function imageStub(route: Route) {
  const response = await route.fetch({ maxRedirects: 0 });
  const location = response.headers().location ?? '';
  if (response.status() === 302 && location.startsWith(`${IMAGE_HOST}/`)) await route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
  else await route.fulfill({ response });
}

test.beforeEach(async ({ context }) => {
  await context.route('**/api/public/store/*/images/**', (route) => imageStub(route).catch(() => { /* the test ended with the image in flight */ }));
  // "Order on WhatsApp" and "Ask on WhatsApp" open wa.me: answered locally so the run never leaves the machine.
  await context.route('https://wa.me/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>wa.me stub</p>' }));
  // A refused request is a finding of its own (a rate limit a real buyer would hit too): logged with its path.
  context.on('response', (response) => {
    if (response.status() === 429) console.log(`[429] ${new URL(response.url()).pathname}`);
  });
  context.on('console', (message) => {
    if (message.type() === 'error') console.log(`[console] ${message.text().slice(0, message.text().includes('hydrated') ? 20000 : 200)}`);
  });
});

test.beforeAll(async () => {
  const a = await seedWorkspace('store');
  const b = await seedWorkspace('store-other');
  const run = randomBytes(4).toString('hex');
  const handle = `e2e-${run}`;
  const ids = { number: randomUUID(), oils: randomUUID(), teas: randomUUID(), contact: randomUUID(), otherContact: randomUUID(),
    session: randomUUID(), otherSession: randomUUID(), order: randomUUID(), hero: randomUUID() };
  const hero = { id: ids.hero, slug: 'brahmi-hair-oil', name: `Brahmi Hair Oil ${run}` };
  let cached!: Seed['cached'];
  await withDb(async (db) => {
    await db.query('BEGIN');
    try {
      const q = (sql: string, values: unknown[]) => db.query(sql, values);
      await q(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,legal_name,state_code,
        document_prefix,storefront_title) VALUES($1,'INR',true,1800,true,'E2E Journey Store','29','RCPT',$2)`, [a.accountId, `E2E Journey ${run}`]);
      await q(`INSERT INTO shipping_rates(account_id,name,country,fee_minor) VALUES($1,'India','IN',5000)`, [a.accountId]);
      await q(`INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc) VALUES($1,'razorpay','test',$2,'enc')`,
        [a.accountId, `rzp_test_J${run}`]);
      await q(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,access_token,status) VALUES($1,$2,$3,$4,'unused','connected')`,
        [ids.number, a.accountId, a.owner.id, `pn-journey-${run}`]);
      await q(`INSERT INTO shop_storefronts(account_id,handle,published,template,whatsapp_config_id,whatsapp_phone)
        VALUES($1,$2,true,'wellness',$3,'919800000123')`, [a.accountId, handle, ids.number]);
      await q(`INSERT INTO shop_categories(id,account_id,name,position,slug) VALUES($1,$3,'Herbal oils',1,'herbal-oils'),($2,$3,'Teas',2,'teas')`,
        [ids.oils, ids.teas, a.accountId]);

      const product = async (id: string, name: string, slug: string, category: string, variants: Array<{ options: Record<string, string>; price: number; stock: number }>) => {
        await q(`INSERT INTO shop_products(id,account_id,name,description,status,content_reviewed_by,content_reviewed_at,category_id,slug)
          VALUES($1,$2,$3,'Cold-pressed, small batch.','published',$4,NOW(),$5,$6)`, [id, a.accountId, name, a.owner.id, category, slug]);
        await q(`INSERT INTO shop_product_images(account_id,product_id,url,position) VALUES($1,$2,$3,0)`, [a.accountId, id, `${IMAGE_HOST}/${slug}.png`]);
        for (const [i, v] of variants.entries()) {
          const variantId = randomUUID();
          await q(`INSERT INTO shop_variants(id,account_id,product_id,sku,option_values,price_minor,position) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [variantId, a.accountId, id, `J${run}-${slug}-${i}`.slice(0, 64), JSON.stringify(v.options), v.price, i]);
          await q('INSERT INTO inventory_levels(account_id,variant_id,on_hand,reserved) VALUES($1,$2,$3,0)', [a.accountId, variantId, v.stock]);
        }
      };
      // The hero: Size x Pack. 100ml/Single has 3 left (the quantity cap); 100ml/Duo is sold out.
      await product(ids.hero, hero.name, hero.slug, ids.oils, [
        { options: { Size: '100ml', Pack: 'Single' }, price: 45000, stock: 3 },
        { options: { Size: '100ml', Pack: 'Duo' }, price: 85000, stock: 0 },
        { options: { Size: '200ml', Pack: 'Single' }, price: 75000, stock: 10 },
        { options: { Size: '200ml', Pack: 'Duo' }, price: 140000, stock: 10 },
      ]);
      // 26 more oils (27 in the category: more than one 24-product page) and 4 teas.
      for (let n = 1; n <= 26; n++) {
        const nn = String(n).padStart(2, '0');
        const id = randomUUID();
        await product(id, `Herbal Oil ${nn}`, `herbal-oil-${nn}`, ids.oils, [{ options: { Size: '100ml' }, price: 10000 + n * 500, stock: 20 }]);
        if (n === 5) cached = { id, slug: 'herbal-oil-05', name: 'Herbal Oil 05' };
      }
      for (let n = 1; n <= 4; n++) {
        await product(randomUUID(), `Tulsi Tea ${n}`, `tulsi-tea-${n}`, ids.teas, [{ options: { Pack: '50g' }, price: 20000 + n * 1000, stock: 15 }]);
      }

      // A buyer (the checkout session the server issues after the OTP or the WhatsApp code; here made directly, as the seed does).
      await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'E2E Journey Buyer',$4)",
        [ids.contact, a.accountId, a.owner.id, `1417${String(Date.now()).slice(-7)}`]);
      await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'E2E Other Buyer',$4)",
        [ids.otherContact, b.accountId, b.owner.id, `1418${String(Date.now()).slice(-7)}`]);
      const address = { name: 'E2E Journey Buyer', phone: '+919900000009', line1: '9 MG Road', city: 'Bengaluru', state: 'Karnataka',
        state_code: '29', postal_code: '560001', country: 'IN' };
      await q(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,discount_minor,shipping_minor,tax_minor,
          tax_inclusive,total_minor,status,priced_at,shipping_address,paid_at,amount_paid_minor,checkout_attempt)
        VALUES($1,$2,'storefront',$3,'INR',45000,0,5000,7627,true,50000,'paid',NOW() - interval '1 hour',$4,NOW() - interval '50 minutes',50000,1)`,
        [ids.order, a.accountId, ids.contact, JSON.stringify(address)]);
      await q(`INSERT INTO order_items(account_id,order_id,sku,retailer_id,name,quantity,unit_price_minor,currency,tax_rate_bps,tax_minor,
          discount_minor,line_total_minor,hsn_code) VALUES($1,$2,$3,$3,$4,1,45000,'INR',1800,6864,0,45000,'30049011')`,
        [a.accountId, ids.order, `J${run}-TRACK`, hero.name]);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
    const checkoutToken = deriveStorefrontToken(ids.session, 1);
    const otherToken = deriveStorefrontToken(ids.otherSession, 1);
    await db.query(`INSERT INTO storefront_sessions(id,account_id,token_hash,contact_id,whatsapp_config_id,purpose,expires_at)
      VALUES($1,$2,$3,$4,$5,'shop',NOW() + interval '24 hours')`, [ids.session, a.accountId, storefrontTokenHash(checkoutToken), ids.contact, ids.number]);
    await db.query(`INSERT INTO storefront_sessions(id,account_id,token_hash,contact_id,purpose,expires_at)
      VALUES($1,$2,$3,$4,'shop',NOW() + interval '24 hours')`, [ids.otherSession, b.accountId, storefrontTokenHash(otherToken), ids.otherContact]);
    seed = { a, b, handle, run, hero, cached, checkoutToken, otherToken,
      trackingToken: orderTrackingToken(a.accountId, ids.order), orderItem: hero.name };
  });
});

test.afterAll(async () => {
  if (seed) await removeWorkspaces([seed.a.accountId, seed.b.accountId], [seed.a.owner.id, seed.b.owner.id]);
  if (timings.length) {
    console.log('\n[timings] server response (responseStart - requestStart, ms), next dev');
    console.table(timings);
  }
});

// First, before anything warms this shop's data cache: each route is compiled on a handle that does not exist
// (a 404 before any data is read), then this shop's page is loaded twice.
test('timings: first and cached server response for home, category and product', async ({ page }) => {
  const s = `/s/${seed.handle}`;
  const pages: Array<[string, string, string]> = [
    ['home', s, '/s/zz-no-such-shop'],
    ['category', `${s}/c/herbal-oils`, '/s/zz-no-such-shop/c/x'],
    ['product', `${s}/p/herbal-oil-01`, '/s/zz-no-such-shop/p/x'],
  ];
  for (const [, , warm] of pages) expect((await page.request.get(warm)).status()).toBe(404);
  for (const [name, url] of pages) {
    expect((await page.goto(url))?.status()).toBe(200);
    const first = await serverTime(page);
    await page.goto(url);
    timings.push({ page: name, first, cached: await serverTime(page) });
  }
});

test('browse: home, a category with sort and paging', async ({ page }) => {
  const s = `/s/${seed.handle}`;
  await page.goto(s);
  await expect(page.locator('header')).toContainText(`E2E Journey ${seed.run}`);
  await expect(page.getByRole('heading', { level: 3 }).first()).toBeVisible();
  await shot(page, '01-home');
  await layoutReport(page, 'home');

  await page.goto(`${s}/c/herbal-oils`);
  await expect(page.getByRole('heading', { level: 1, name: 'Herbal oils' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '27 products' })).toBeVisible();
  await expect(page.locator('main h3')).toHaveCount(24);
  await shot(page, '02-category');
  await layoutReport(page, 'category');

  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(page).toHaveURL(/after=/);
  await expect(page.locator('main h3')).toHaveCount(3);
  await expect(page.getByRole('link', { name: 'First page' })).toBeVisible();
  await shot(page, '03-category-page-2');

  await page.goto(`${s}/c/herbal-oils`);
  await page.getByLabel('Sort').selectOption('price_asc');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/sort=price_asc/);
  await expect(page.locator('main h3').first()).toHaveText('Herbal Oil 01');
  await shot(page, '04-category-sorted');
});

test('product: sticky buy bar, sold-out combination, quantity cap, ask on WhatsApp, old id link', async ({ page }) => {
  const s = `/s/${seed.handle}`;
  const response = await page.goto(`${s}/p/${seed.hero.slug}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: seed.hero.name })).toBeVisible();
  await shot(page, '05-product');
  await layoutReport(page, 'product');

  // Quantity: 3 left of 100ml/Single, so "More" stops at 3.
  const more = page.getByRole('button', { name: 'More', exact: true });
  await more.click();
  await more.click();
  await expect(more).toBeDisabled();
  await expect(page.getByText('Only 3 left').first()).toBeVisible();

  // 100ml/Duo is sold out: marked unavailable, and picking it disables Add to cart.
  const duo = page.getByRole('button', { name: 'Duo, sold out' });
  await expect(duo).toHaveAttribute('aria-disabled', 'true');
  // Sold out stays tappable (so Notify me can be reached): aria-disabled, not disabled, so Playwright needs force.
  await duo.click({ force: true });
  await expect(page.getByRole('button', { name: 'Add to cart' }).first()).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'Sold out' })).toBeVisible();
  await page.getByRole('button', { name: 'Single', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add to cart' }).first()).toBeEnabled();

  // Ask on WhatsApp: the message names the product (the href is completed on tap).
  const ask = page.getByRole('link', { name: 'Ask about this product on WhatsApp' });
  await page.evaluate(() => document.addEventListener('click', (e) => {
    if ((e.target as Element).closest('a[href^="https://wa.me/"]')) e.preventDefault();
  }));
  await ask.click();
  expect(decodeURIComponent((await ask.getAttribute('href')) ?? '')).toContain(seed.hero.name);

  // Phone buy bar: shown once the main button scrolls away.
  await page.mouse.wheel(0, 1500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const bar = page.getByRole('region', { name: 'Buy' });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(seed.hero.name);
  await page.waitForTimeout(600); // the slide-in animation
  const barBox = await bar.boundingBox();
  console.log(`[layout] buy bar: top=${Math.round(barBox?.y ?? -1)} height=${Math.round(barBox?.height ?? -1)} (viewport 844)`);
  // The floating "Chat on WhatsApp" button moves up out of the bar's way (it covered Add to cart).
  const chatBox = await page.getByRole('link', { name: 'Chat on WhatsApp' }).boundingBox();
  expect(chatBox && barBox && chatBox.y + chatBox.height <= barBox.y).toBeTruthy();
  await page.screenshot({ path: path.join(SHOTS, '06-product-buy-bar.png') });

  // An old id link moves for good to the slug address.
  const old = await page.request.get(`${s}/p/${seed.hero.id}`, { maxRedirects: 0 });
  expect(old.status()).toBe(308);
  expect(old.headers().location).toContain(`${s}/p/${seed.hero.slug}`);
  await page.goto(`${s}/p/${seed.hero.id}`);
  await expect(page).toHaveURL(new RegExp(`/p/${seed.hero.slug}$`));
});

test('cart and checkout: estimate before the WhatsApp code, one coupon answer, themed checkout, foreign token 404', async ({ page }) => {
  const s = `/s/${seed.handle}`;
  await page.goto(`${s}/p/${seed.hero.slug}`);
  await page.getByRole('button', { name: 'Add to cart' }).first().click();
  await expect(page.getByText('Added').first()).toBeVisible();
  await page.goto(`${s}/cart`);
  await expect(page.getByRole('heading', { name: 'Cart' })).toBeVisible();
  await expect(page.getByRole('link', { name: seed.hero.name })).toBeVisible();

  await page.getByLabel('Pincode for shipping').fill('560001');
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  const summary = page.locator('aside dl');
  await expect(summary).toContainText('Shipping');
  await expect(summary).toContainText('₹50.00');
  await expect(summary).toContainText('Estimated total');

  await page.getByLabel('Coupon code').fill('NOSUCH10');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('That coupon cannot be used on this bag.')).toHaveCount(1);
  await expect(page.locator('aside [role="alert"]')).toHaveCount(1);

  // The estimate sits above the WhatsApp ordering button.
  const whatsapp = page.getByRole('button', { name: 'Order on WhatsApp' });
  const [totalBox, buttonBox] = [await summary.boundingBox(), await whatsapp.boundingBox()];
  expect(totalBox && buttonBox && totalBox.y + totalBox.height <= buttonBox.y).toBeTruthy();
  await shot(page, '07-cart');
  await layoutReport(page, 'cart');

  // The cart's code goes into the prefilled WhatsApp message ("... ORDER <CODE>").
  await whatsapp.click();
  await page.waitForURL(/^https:\/\/wa\.me\//);
  const text = new URL(page.url()).searchParams.get('text') ?? '';
  expect(text).toContain(seed.hero.name);
  const code = /ORDER ([A-HJ-NP-Z2-9]{6})$/.exec(text)?.[1];
  expect(code).toBeTruthy();
  console.log(`[cart] WhatsApp message ends with ORDER ${code}`);

  // Checkout through the session the server would issue: only the cart, the address and payment.
  await page.goto(`${s}/checkout/${seed.checkoutToken}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeVisible();
  await expect(page.getByText('Your cart')).toBeVisible();
  await expect(page.getByText('Delivery address')).toBeVisible();
  await expect(page.locator('main')).toContainText(seed.hero.name);
  await expect(page.locator('main h3')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('Herbal Oil 01');
  await page.locator('#addr-name').fill('E2E Journey Buyer');
  await page.locator('#addr-phone').fill('+919900000009');
  await page.locator('#addr-line1').fill('9 MG Road');
  await page.locator('#addr-city').fill('Bengaluru');
  await page.locator('#addr-state').fill('Karnataka');
  await page.locator('#addr-postal_code').fill('560001');
  await page.locator('#addr-country').fill('IN');
  await page.getByRole('button', { name: 'Use this address' }).click();
  // Online payment is the only method here, so payment is the pay button (not clicked: nothing is paid).
  await expect(page.locator('main')).toContainText('Shipping (India)');
  await expect(page.getByRole('button', { name: /^Place order and pay/ })).toBeEnabled();
  // Phone-sized fields on the themed checkout (buttons grow on a coarse pointer, which headless Chromium may not report).
  for (const field of ['#addr-name', '#addr-postal_code', '#checkout-email']) {
    expect((await page.locator(field).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await shot(page, '08-checkout');
  await layoutReport(page, 'checkout');

  // Another workspace's live link under this shop's handle is the plain 404.
  expect((await page.goto(`${s}/checkout/${seed.otherToken}`))?.status()).toBe(404);
});

test('tracking: an order of this shop', async ({ page }) => {
  const response = await page.goto(`/s/${seed.handle}/track/${seed.trackingToken}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('main')).toContainText(seed.orderItem);
  await expect(page.locator('main')).toContainText('Order placed');
  await shot(page, '09-tracking');
  await layoutReport(page, 'tracking');
});

test('sitemap lists the slug address and robots keeps crawlers out of checkout', async ({ request, baseURL }) => {
  const sitemap = await request.get(`/s/${seed.handle}/sitemap.xml`);
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()['content-type']).toContain('xml');
  const xml = await sitemap.text();
  expect(xml).toContain('<urlset');
  expect(xml).toContain(`${new URL(baseURL as string).origin}/s/${seed.handle}/p/${seed.hero.slug}</loc>`);
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toMatch(/Disallow: \/s\/\*\/checkout/);
});

test('cache: a staff save shows at once; a direct SQL change waits for the TTL', async ({ page, browser }) => {
  const url = `/s/${seed.handle}/p/${seed.cached.slug}`;
  // goto, never reload: a reload sends Cache-Control: no-cache, and next dev then skips the data cache (incremental-cache get).
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(seed.cached.name);
  await page.goto(url);
  // Before any staff save: is a direct SQL change (no revalidate) held back by the cache at all?
  const early = `Herbal Oil 05 Early ${seed.run}`;
  await withDb((db) => db.query('UPDATE shop_products SET name=$1 WHERE account_id=$2 AND id=$3', [early, seed.a.accountId, seed.cached.id]));
  const earlyHtml = await (await page.request.get(url)).text();
  console.log(`[cache] before any staff save, a direct SQL rename shows ${earlyHtml.includes(early) ? 'at once (not cached)' : 'the old name (cached)'}`);

  const staff = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const staffPage = await staff.newPage();
  try {
    await login(staffPage, seed.a.owner);
    const current = await (await staffPage.request.get(`/api/commerce/shop/products/${seed.cached.id}`)).json();
    const renamed = `Herbal Oil 05 Renamed ${seed.run}`;
    const saved = await staffWrite(staffPage, 'PATCH', `/api/commerce/shop/products/${seed.cached.id}`,
      { version: current.product.version, name: renamed, slug: seed.cached.slug });
    expect(saved.status()).toBe(200);
    await page.goto(url);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(renamed);
    await shot(page, '10-cache-after-staff-save');

    const direct = `Herbal Oil 05 SQL ${seed.run}`;
    await withDb((db) => db.query('UPDATE shop_products SET name=$1 WHERE account_id=$2 AND id=$3', [direct, seed.a.accountId, seed.cached.id]));
    const navigation = await page.goto(url);
    const shown = (await page.getByRole('heading', { level: 1 }).textContent())?.trim();
    const cacheControl = (await navigation?.request().allHeaders())?.['cache-control'] ?? '(none)';
    // The same page without a browser (no Cache-Control header at all).
    const html = await (await page.request.get(url)).text();
    const plain = html.includes(direct) ? direct : html.includes(renamed) ? renamed : '?';
    const verdict = (name: string | undefined) => (name === direct ? 'the new name (not cached)' : `the old name "${name}" (stale, up to 90 s by design)`);
    console.log(`[cache] after a direct SQL rename (no revalidate): browser navigation (cache-control ${cacheControl}) shows ${verdict(shown)}; `
      + `plain GET shows ${verdict(plain)}`);
    // Once more, a few seconds later: does the cache hold again after one fresh load, or stay bypassed after a revalidate?
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const later = `Herbal Oil 05 Later ${seed.run}`;
    await withDb((db) => db.query('UPDATE shop_products SET name=$1 WHERE account_id=$2 AND id=$3', [later, seed.a.accountId, seed.cached.id]));
    const laterHtml = await (await page.request.get(url)).text();
    console.log(`[cache] a second direct SQL rename 3 s later shows ${laterHtml.includes(later) ? 'at once (still not cached)' : 'the old name (cached again)'}`);
  } finally {
    await staff.close();
  }
});
