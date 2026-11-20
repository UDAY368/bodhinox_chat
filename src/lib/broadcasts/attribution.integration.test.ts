import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Campaign sales on PostgreSQL: the attribution window, the latest campaign winning, only paid orders,
// refunds taken off, currencies kept apart, and nothing read from another workspace.
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { campaignSales } from './attribution';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const account = randomUUID(), other = randomUUID(), owner = randomUUID();
const c = Object.fromEntries(['a', 'b', 'late', 'unpaid', 'refunded', 'usd', 'foreign', 'early'].map((n) => [n, randomUUID()])) as Record<string, string>;
const b = Object.fromEntries(['first', 'second', 'foreign'].map((n) => [n, randomUUID()])) as Record<string, string>;
let db: pg.Client;

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T12:00:00Z');
const at = (days: number) => new Date(T0 + days * DAY);

const reach = (ac: string, broadcast: string, contact: string, deliveredDay: number | null, readDay: number | null = null) => db.query(
  `INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status,sent_at,delivered_at,read_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
  [ac, broadcast, contact, readDay !== null ? 'read' : deliveredDay !== null ? 'delivered' : 'sent', at(Math.min(deliveredDay ?? readDay ?? 0, readDay ?? Infinity)),
    deliveredDay === null ? null : at(deliveredDay), readDay === null ? null : at(readDay)]);
const order = (ac: string, contact: string, day: number, status: string, total: number, over: { currency?: string; refunded?: number } = {}) => db.query(
  `INSERT INTO orders(account_id,source,contact_id,currency,subtotal_minor,shipping_minor,tax_minor,tax_inclusive,total_minor,status,priced_at,amount_paid_minor,amount_refunded_minor,refund_state,created_at)
   VALUES($1,'storefront',$2,$3,$4::bigint,0,0,true,$4::bigint,$5,$6,$4::bigint,$7::bigint,$8,$6)`,
  [ac, contact, over.currency ?? 'INR', total, status, at(day), over.refunded ?? 0, over.refunded ? (over.refunded >= total ? 'full' : 'partial') : 'none']);

describe.skipIf(!ownerUrl || !appUrl)('campaign sales attribution on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'ATTR','test-only-hash')", [owner, `${owner}@example.invalid`]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'ATTR shop',$3),($2,'ATTR other',$3)", [account, other, owner]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$3,'owner'),($2,$3,'owner')", [account, other, owner]);
    for (const [i, [key, id]] of Object.entries(c).entries()) {
      await db.query('INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,$4,$5)',
        [id, key === 'foreign' ? other : account, owner, `Contact ${key}`, `+1415300${String(i).padStart(4, '0')}`]);
    }
    await db.query(`INSERT INTO broadcasts(id,account_id,user_id,name,template_name,status) VALUES
      ($1,$4,$5,'First','t1','sent'),($2,$4,$5,'Second','t2','sent'),($3,$6,$5,'Foreign','t3','sent')`, [b.first, b.second, b.foreign, account, owner, other]);

    // a: got First on day 0 and Second on day 2, bought on day 3 -> Second (the latest) wins.
    await reach(account, b.first, c.a, 0);
    await reach(account, b.second, c.a, 2);
    await order(account, c.a, 3, 'paid', 10_000);
    // b: got First on day 0 (read only, no delivery receipt), bought on day 5 -> First.
    await reach(account, b.first, c.b, null, 0);
    await order(account, c.b, 5, 'fulfilled', 20_000);
    // late: got First on day 0, bought on day 8 -> outside the 7-day window.
    await reach(account, b.first, c.late, 0);
    await order(account, c.late, 8, 'paid', 40_000);
    // early: bought on day 0, the campaign arrived after the order -> not attributed.
    await order(account, c.early, 0, 'paid', 80_000);
    await reach(account, b.first, c.early, 1);
    // unpaid: an order waiting for payment and a cancelled one do not count.
    await reach(account, b.first, c.unpaid, 0);
    await order(account, c.unpaid, 1, 'awaiting_payment', 160_000);
    await order(account, c.unpaid, 1, 'cancelled', 320_000);
    // refunded: paid 5,000, 2,000 refunded -> 3,000; and a fully refunded order counts with no revenue.
    await reach(account, b.first, c.refunded, 0);
    await order(account, c.refunded, 1, 'dispatched', 5_000, { refunded: 2_000 });
    await order(account, c.refunded, 2, 'paid', 7_000, { refunded: 7_000 });
    // usd: another currency is reported apart, never added to rupees.
    await reach(account, b.first, c.usd, 0);
    await order(account, c.usd, 1, 'paid', 999, { currency: 'USD' });
    // foreign: the other workspace's campaign and order.
    await reach(other, b.foreign, c.foreign, 0);
    await order(other, c.foreign, 1, 'paid', 640_000);
  });

  afterAll(async () => {
    if (db) {
      for (const ac of [account, other]) {
        await db.query('DELETE FROM orders WHERE account_id=$1', [ac]).catch(() => undefined);
        await db.query('DELETE FROM broadcast_recipients WHERE account_id=$1', [ac]).catch(() => undefined);
        await db.query('DELETE FROM accounts WHERE id=$1', [ac]).catch(() => undefined);
      }
      await db.query('DELETE FROM auth_users WHERE id=$1', [owner]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  const salesOf = (ac: string, ids: string[]) => withTenant({ accountId: ac, userId: owner, role: 'owner' }, (tx) => campaignSales(tx, ac, ids));

  it('attributes paid orders to the latest campaign received in the 7 days before, per currency, refunds taken off', async () => {
    const sales = await salesOf(account, [b.first, b.second]);
    expect(sales[b.second]).toEqual({ orders: 1, revenue: [{ currency: 'INR', minor: 10_000 }] });
    // First: b (20,000) + refunded (3,000 + 0) in INR, and usd apart. Not a (Second won), late, early or unpaid.
    expect(sales[b.first]).toEqual({ orders: 4, revenue: [{ currency: 'INR', minor: 23_000 }, { currency: 'USD', minor: 999 }] });
  });

  it('the latest campaign wins even when only the earlier one is asked about', async () => {
    const sales = await salesOf(account, [b.first]);
    expect(sales[b.first].orders).toBe(4);
    expect(sales[b.second]).toBeUndefined();
  });

  it("reads nothing of another workspace: its campaign id here has no sales, and it sees none of this workspace's", async () => {
    expect((await salesOf(account, [b.foreign]))[b.foreign]).toEqual({ orders: 0, revenue: [] });
    const theirs = await salesOf(other, [b.foreign, b.first]);
    expect(theirs[b.foreign]).toEqual({ orders: 1, revenue: [{ currency: 'INR', minor: 640_000 }] });
    expect(theirs[b.first]).toEqual({ orders: 0, revenue: [] });
  });

  it('is empty for no campaigns', async () => {
    expect(await salesOf(account, [])).toEqual({});
  });
});
