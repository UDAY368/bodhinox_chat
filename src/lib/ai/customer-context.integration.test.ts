import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The AI auto-reply's customer context on PostgreSQL, read as the worker role: only products the public shop shows,
// only this contact's own orders in this workspace, the cap, and a fixed number of queries whatever the row counts.
const h = vi.hoisted(() => ({ booking: null as string | null }));
vi.mock('@/lib/appointments/ai-context', () => ({ customerBookingContext: async () => h.booking }));

import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { orderTrackingToken } from '@/lib/commerce/order-tracking-token';
import { buildCustomerContext, CUSTOMER_CONTEXT_MAX_CHARS, loadCustomerContext } from './customer-context';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const account = randomUUID(), other = randomUUID(), owner = randomUUID();
const buyer = randomUUID(), buyer2 = randomUUID(), foreignBuyer = randomUUID(), quiet = randomUUID();
const p = Object.fromEntries(['kurta', 'kurtaSoldOut', 'draft', 'archived', 'hidden', 'foreign', 'unpriced'].map((n) => [n, randomUUID()])) as Record<string, string>;
const o = Object.fromEntries(['old', 'mid', 'new', 'newest', 'buyer2', 'foreign'].map((n) => [n, randomUUID()])) as Record<string, string>;
const handle = `aictx-${account.slice(0, 8)}`;
let db: pg.Client;

/** A tenant transaction that counts its SQL round trips. */
async function counted<T>(ac: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<{ value: T; queries: number }> {
  let queries = 0;
  const value = await withTenant({ accountId: ac, role: 'owner' }, (tx) => fn(new Proxy(tx, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof key === 'string' && key.startsWith('$query') && typeof value === 'function') {
        return (...args: unknown[]) => { queries += 1; return value.apply(target, args); };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  })), getWorkerPrisma());
  return { value, queries };
}

const order = (id: string, ac: string, contact: string, status: string, agoMinutes: number, over: { external?: string; paid?: boolean; payment?: string; total?: number } = {}) => db.query(
  `INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,shipping_minor,tax_minor,tax_inclusive,total_minor,status,priced_at,paid_at,amount_paid_minor,payment_method,external_id,created_at)
   VALUES($1,$2,'storefront',$3,'INR',$4::bigint,0,0,true,$4::bigint,$5,now(),CASE WHEN $6::boolean THEN now() END,CASE WHEN $6::boolean THEN $4::bigint ELSE 0 END,$7,$8,
     now() - make_interval(mins => $9::int))`,
  [id, ac, contact, over.total ?? 49900, status, over.paid ?? false, over.payment ?? 'online', over.external ?? null, agoMinutes]);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('AI customer context on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'AICTX','test-only-hash')", [owner, `${owner}@example.invalid`]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'AICTX shop',$3),($2,'AICTX other',$3)", [account, other, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [account, other]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$3,'owner'),($2,$3,'owner')", [account, other, owner]);
    await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$5,$7,'Buyer','+14150000001'),($2,$5,$7,'Buyer two','+14150000002'),
      ($3,$6,$7,'Foreign buyer','+14150000003'),($4,$5,$7,'Quiet','+14150000004')`, [buyer, buyer2, foreignBuyer, quiet, account, other, owner]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled) VALUES($1,'INR',true,0,true),($2,'INR',true,0,true)`, [account, other]);
    await db.query(`INSERT INTO shop_storefronts(account_id,handle,published,template) VALUES($1,$2,true,'wellness'),($3,$4,true,'wellness')`,
      [account, handle, other, `aictx-o-${other.slice(0, 8)}`]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at,hide_at) VALUES
      ($1,$8,'Cotton Kurta','published',now(),NULL),($2,$8,'Silk Kurta','published',now(),NULL),($3,$8,'Draft Kurta','draft',now(),NULL),
      ($4,$8,'Archived Kurta','archived',now(),NULL),($5,$8,'Hidden Kurta','published',now(),now() - interval '1 day'),
      ($6,$9,'Foreign Kurta','published',now(),NULL),($7,$8,'Unpriced Kurta','published',now(),NULL)`,
    [p.kurta, p.kurtaSoldOut, p.draft, p.archived, p.hidden, p.foreign, p.unpriced, account, other]);
    const soldOutVariant = randomUUID();
    await db.query(`INSERT INTO shop_variants(account_id,product_id,sku,price_minor,track_inventory) VALUES
      ($1,$2,'K-S',49900,false),($1,$2,'K-L',59900,false),($1,$3,'D',100,false),($1,$4,'A',100,false),($1,$5,'H',100,false),
      ($6,$7,'F',100,false),($1,$8,'U',NULL,false)`,
    [account, p.kurta, p.draft, p.archived, p.hidden, other, p.foreign, p.unpriced]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,track_inventory) VALUES($1,$2,$3,'SK',129900,true)`, [soldOutVariant, account, p.kurtaSoldOut]);
    await db.query(`INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,0)`, [account, soldOutVariant]);

    await order(o.old, account, buyer, 'cancelled', 400);
    await order(o.mid, account, buyer, 'fulfilled', 300, { paid: true, external: '1001' });
    await order(o.new, account, buyer, 'dispatched', 200, { paid: true });
    await order(o.newest, account, buyer, 'confirmed', 100, { payment: 'cod', total: 129900 });
    await order(o.buyer2, account, buyer2, 'paid', 50, { paid: true, external: 'B2-SECRET' });
    await order(o.foreign, other, foreignBuyer, 'paid', 10, { paid: true, external: 'FOREIGN-1' });
  });

  afterAll(async () => {
    if (db) {
      for (const ac of [account, other]) {
        await db.query('DELETE FROM orders WHERE account_id=$1', [ac]).catch(() => undefined);
        await db.query('DELETE FROM accounts WHERE id=$1', [ac]).catch(() => undefined);
      }
      await db.query('DELETE FROM auth_users WHERE id=$1', [owner]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  beforeEach(() => { h.booking = null; });

  it('lists only products the public shop shows, with price, stock and link', async () => {
    const { value } = await counted(account, (tx) => buildCustomerContext(tx, account, quiet, 'Do you have a kurta in size L?'));
    expect(value).toContain(`- Cotton Kurta: from ₹499.00, in stock, https://app.example.test/s/${handle}/p/${p.kurta}`);
    expect(value).toContain(`- Silk Kurta: ₹1,299.00, out of stock, https://app.example.test/s/${handle}/p/${p.kurtaSoldOut}`);
    for (const hidden of ['Draft Kurta', 'Archived Kurta', 'Hidden Kurta', 'Foreign Kurta', 'Unpriced Kurta']) expect(value).not.toContain(hidden);
    expect(value).not.toContain('orders');
  });

  it('shows no products while the shop is unpublished', async () => {
    await db.query('UPDATE shop_storefronts SET published=false WHERE account_id=$1', [account]);
    try {
      const { value } = await counted(account, (tx) => buildCustomerContext(tx, account, quiet, 'kurta'));
      expect(value).toBeNull();
    } finally {
      await db.query('UPDATE shop_storefronts SET published=true WHERE account_id=$1', [account]);
    }
  });

  it("lists only this contact's own latest three orders in this workspace, in plain words, with the tracking link", async () => {
    const value = (await counted(account, (tx) => buildCustomerContext(tx, account, buyer, 'where is my order?'))).value!;
    const lines = value.split('\n');
    expect(lines[0]).toBe("This customer's latest orders (newest first):");
    expect(lines[1]).toBe(`- Order ${o.newest.slice(0, 8).toUpperCase()}: confirmed, cash on delivery, total ₹1,299.00, tracking https://app.example.test/s/${handle}/track/${orderTrackingToken(account, o.newest)}`);
    expect(lines[2]).toContain(`- Order ${o.new.slice(0, 8).toUpperCase()}: shipped, paid, total ₹499.00`);
    expect(lines[3]).toContain('- Order #1001: delivered, paid');
    expect(lines).toHaveLength(4);
    expect(value).not.toContain('B2-SECRET');
    expect(value).not.toContain('FOREIGN-1');
    expect(value).not.toContain(o.old.slice(0, 8).toUpperCase());
    expect(value).not.toMatch(/\+1415/);
  });

  it('reads nothing of another workspace', async () => {
    // Another workspace's contact id asked in this workspace: nothing of theirs.
    const here = (await counted(account, (tx) => buildCustomerContext(tx, account, foreignBuyer, 'foreign'))).value;
    expect(here).toBeNull();
    // This workspace's contact id asked in the other workspace (its tenant): none of this workspace's orders or products.
    expect((await counted(other, (tx) => buildCustomerContext(tx, other, buyer, 'cotton'))).value).toBeNull();
    const value = (await counted(other, (tx) => buildCustomerContext(tx, other, foreignBuyer, 'kurta order'))).value!;
    expect(value).toContain('#FOREIGN-1');
    expect(value).toContain('Foreign Kurta');
    expect(value).not.toContain('Cotton Kurta');
    expect(value).not.toContain('#1001');
  });

  it('adds the booking lines and keeps the whole block under the cap', async () => {
    h.booking = Array.from({ length: 10 }, (_, i) => `Booking line ${i} ${'x'.repeat(250)}`).join('\n');
    const value = (await counted(account, (tx) => buildCustomerContext(tx, account, buyer, 'kurta'))).value!;
    expect(value).toContain("This customer's bookings:\nBooking line 0");
    expect(value.length).toBeLessThanOrEqual(CUSTOMER_CONTEXT_MAX_CHARS);
  });

  it('runs a fixed number of queries whatever the number of matching products and orders (no N+1)', async () => {
    const few = await counted(account, (tx) => buildCustomerContext(tx, account, buyer2, 'kurta'));
    const many = await counted(account, (tx) => buildCustomerContext(tx, account, buyer, 'cotton silk kurta'));
    expect(few.queries).toBe(3);
    expect(many.queries).toBe(3);
  });

  it('the auto-reply entry point reads as the worker and gives null for a stranger with no products named', async () => {
    expect(await loadCustomerContext(account, randomUUID(), 'hello')).toBeNull();
    expect(await loadCustomerContext(account, buyer, 'hello')).toContain('#1001');
  });
});
