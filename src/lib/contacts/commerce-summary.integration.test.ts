// The chat side panel's Orders / Payments / Deals summary and the profile's
// payments pages on PostgreSQL: newest few with true counts, payments found
// through the contact's orders and payment links, viewers get deals only, and
// another workspace's contact is null (the routes answer 404).
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { contactCommerceSummary, contactPaymentsPage, PAYMENTS_PAGE_SIZE, SUMMARY_LIMIT } from './commerce-summary';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const ownerA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const seed = String(Date.now()).slice(-8);
let db: pg.Client;
let asha: string, ravi: string, other: string;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const asOwner = { accountId: A, userId: ownerA, role: 'owner' as const };
const asViewer = { accountId: A, userId: viewerA, role: 'viewer' as const };
const asB = { accountId: B, userId: ownerB, role: 'owner' as const };
const ADDRESS = JSON.stringify({ name: 'Asha', phone: '+919800000000', line1: '1 MG Road', city: 'Bengaluru',
  state: 'KA', state_code: 'KA', postal_code: '560001', country: 'IN' });
const ORDERS = 4;
const OFFLINE_ON_LINK = PAYMENTS_PAGE_SIZE + 1;

async function order(account: string, contact: string, at: string) {
  const id = randomUUID();
  await q(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,discount_minor,shipping_minor,tax_minor,
      tax_inclusive,total_minor,status,priced_at,shipping_address,amount_paid_minor,paid_at,created_at)
    VALUES($1,$2,'storefront',$3,'INR',10000,0,0,0,true,10000,'paid',now(),$4::jsonb,10000,now(),$5)`, [id, account, contact, ADDRESS, at]);
  await q(`INSERT INTO customer_payments(account_id,source,provider_payment_id,order_id,amount_minor,currency,status,captured_at,settlement,created_at)
    VALUES($1,'razorpay',$2,$3,10000,'INR','captured',now(),'settled',$4)`, [account, `pay_${id.replace(/-/g, '').slice(0, 14)}`, id, at]);
  return id;
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('contact commerce summary', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    for (const id of [ownerA, viewerA, ownerB])
      await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Summary','test-only-hash')", [id, `${id}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Summary A',$2),($3,'Summary B',$4)", [A, ownerA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer'),($4,$5,'owner')",
      [A, ownerA, viewerA, B, ownerB]);
    asha = (await q("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Asha') RETURNING id", [A, ownerA, `+1517${seed}1`])).rows[0].id;
    ravi = (await q("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Ravi') RETURNING id", [A, ownerA, `+1517${seed}2`])).rows[0].id;
    other = (await q("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Other') RETURNING id", [B, ownerB, `+1517${seed}3`])).rows[0].id;
    for (let i = 0; i < ORDERS; i++) await order(A, asha, `2026-01-0${i + 1}T10:00:00Z`);
    await order(A, ravi, '2026-01-09T10:00:00Z');
    await order(B, other, '2026-01-09T10:00:00Z');
    // Staff-recorded payments against Asha's payment link (no order).
    const link = (await q(`INSERT INTO payment_links(account_id,provider,reference_id,amount_minor,currency,contact_id,status)
      VALUES($1,'razorpay',$2,500,'INR',$3,'created') RETURNING id`, [A, `ref_summary_${seed}`, asha])).rows[0].id;
    for (let i = 0; i < OFFLINE_ON_LINK; i++)
      await q(`INSERT INTO customer_payments(account_id,source,payment_link_id,amount_minor,currency,status,offline_reference,settlement,created_at)
        VALUES($1,'offline',$2,500,'INR','captured',$3,'pending',$4)`, [A, link, `cash-${i}`, `2026-02-01T10:00:${String(i).padStart(2, '0')}Z`]);
    const pipeline = randomUUID(), stage = randomUUID();
    await q("INSERT INTO pipelines(id,account_id,user_id,name) VALUES($1,$2,$3,'Sales')", [pipeline, A, ownerA]);
    await q("INSERT INTO pipeline_stages(id,account_id,pipeline_id,name) VALUES($1,$2,$3,'Proposal')", [stage, A, pipeline]);
    for (const [title, status] of [['One', 'open'], ['Two', 'won'], ['Three', 'open'], ['Four', 'lost']])
      await q('INSERT INTO deals(account_id,user_id,pipeline_id,stage_id,contact_id,title,value,status) VALUES($1,$2,$3,$4,$5,$6,1250.5,$7)',
        [A, ownerA, pipeline, stage, asha, title, status]);
  });
  afterAll(async () => {
    if (db) {
      await q('DELETE FROM audit_logs WHERE account_id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, viewerA, ownerB]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('gives the newest few of each block with the true counts', async () => {
    const summary = (await contactCommerceSummary(asOwner, asha))!;
    expect(summary.orders!.count).toBe(ORDERS);
    expect(summary.orders!.items).toHaveLength(SUMMARY_LIMIT);
    expect(summary.orders!.items[0]).toMatchObject({ currency: 'INR', total_minor: 10000, created_at: '2026-01-04T10:00:00.000Z' });
    // Order payments plus the payment link's offline payments; never Ravi's.
    expect(summary.payments!.count).toBe(ORDERS + OFFLINE_ON_LINK);
    expect(summary.payments!.items).toHaveLength(SUMMARY_LIMIT);
    expect(summary.payments!.items[0]).toMatchObject({ source: 'offline', order_id: null, amount_minor: 500 });
    expect(summary.deals.count).toBe(4);
    expect(summary.deals.items).toHaveLength(SUMMARY_LIMIT);
    expect(summary.deals.items[0]).toMatchObject({ value: 1250.5, stage_name: 'Proposal' });
  });

  it('leaves orders and payments out for a viewer', async () => {
    const summary = (await contactCommerceSummary(asViewer, asha))!;
    expect(summary.orders).toBeNull();
    expect(summary.payments).toBeNull();
    expect(summary.deals.count).toBe(4);
  });

  it("never shows another workspace's contact", async () => {
    expect(await contactCommerceSummary(asOwner, other)).toBeNull();
    expect(await contactCommerceSummary(asB, asha)).toBeNull();
    expect(await contactPaymentsPage(asOwner, other, 0)).toBeNull();
    expect(await contactPaymentsPage(asB, asha, 0)).toBeNull();
  });

  it('pages payments with the total, past the end too', async () => {
    const total = ORDERS + OFFLINE_ON_LINK;
    const first = (await contactPaymentsPage(asOwner, asha, 0))!;
    expect(first).toMatchObject({ total, pageSize: PAYMENTS_PAGE_SIZE });
    expect(first.payments).toHaveLength(PAYMENTS_PAGE_SIZE);
    const second = (await contactPaymentsPage(asOwner, asha, 1))!;
    expect(second.payments).toHaveLength(total - PAYMENTS_PAGE_SIZE);
    expect(new Set([...first.payments, ...second.payments].map((p) => p.id)).size).toBe(total);
    expect(await contactPaymentsPage(asOwner, asha, 9)).toMatchObject({ total, payments: [] });
    expect(await contactPaymentsPage(asOwner, ravi, 0)).toMatchObject({ total: 1 });
  });
});
