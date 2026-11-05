// Customer commerce payments and the platform's SaaS billing never cross
// (Phase 14, design section 3), on a real PostgreSQL:
//   - no foreign key joins a SaaS billing table to a commerce table;
//   - a commerce event signed with the billing secret and sent to the billing
//     webhook creates no billing event, commerce receipt, job or invoice;
//   - a subscription event signed with a workspace's commerce secret and sent
//     to the commerce webhook creates no billing event and no receipt;
//   - each webhook refuses the other's signature.
// The import-graph half is separation.test.ts. Runs only against an isolated *test* database.
import { createHmac, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const COMMERCE_SECRET = 'commerce-webhook-secret-t3';
vi.mock('@/lib/payments/providers', async (orig) => ({
  ...(await orig<typeof import('@/lib/payments/providers')>()),
  // The workspace's own commerce webhook secret (stored encrypted in production).
  loadRazorpaySecrets: async () => ({ keyId: 'rzp_test_commerceT3', keySecret: 'k', webhookSecret: COMMERCE_SECRET }),
}));

import { disconnectDatabases } from '@/lib/db/prisma';
import { POST as billingWebhook } from '@/app/api/billing/webhook/route';
import { POST as commerceWebhook } from '@/app/api/payments/razorpay/webhook/[accountId]/route';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
const BILLING_SECRET = 'billing-webhook-secret-t3';
Object.assign(process.env, {
  BILLING_RAZORPAY_KEY_ID: 'rzp_test_platformT3', BILLING_RAZORPAY_KEY_SECRET: 'test-only', BILLING_RAZORPAY_WEBHOOK_SECRET: BILLING_SECRET,
});

const SAAS = ['plans', 'plan_versions', 'plan_prices', 'account_subscriptions', 'invoices', 'invoice_sequences', 'billing_events',
  'billing_intents', 'add_ons', 'usage_counters', 'usage_events', 'billing_reconciliation_items'];
const COMMERCE = ['payment_providers', 'payment_links', 'webhook_receipts', 'payment_exceptions', 'orders'];
const isCommerce = (t: string) => COMMERCE.includes(t) || t.startsWith('order_');

const tag = randomUUID().slice(0, 8);
const account = randomUUID(), user = randomUUID();
let owner: pg.Client;

const sign = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('hex');
const request = (url: string, body: string, secret: string, eventId: string) => new Request(url, {
  method: 'POST', body, headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(body, secret), 'x-razorpay-event-id': eventId },
});

const paymentLinkPaid = JSON.stringify({
  event: 'payment_link.paid', account_id: 'acc_T3',
  payload: {
    payment_link: { entity: { id: `plink_T3${tag}`, reference_id: `ref_${tag}`, status: 'paid', amount: 50000, currency: 'INR' } },
    payment: { entity: { id: `pay_T3link${tag}`, amount: 50000, currency: 'INR', status: 'captured' } },
  },
});
const subscriptionCharged = JSON.stringify({
  event: 'subscription.charged',
  payload: {
    subscription: { entity: { id: `sub_T3sep${tag}`, plan_id: 'plan_T3sep', status: 'active', notes: { account_id: account } } },
    payment: { entity: { id: `pay_T3sub${tag}`, amount: 118000, currency: 'INR' } },
  },
});

async function counts() {
  const one = async (sql: string, params: unknown[] = []) => Number((await owner.query(sql, params)).rows[0].n);
  return {
    billingEvents: await one("SELECT count(*) AS n FROM billing_events WHERE event_id LIKE $1", [`evt_T3sep${tag}%`]),
    receipts: await one("SELECT count(*) AS n FROM webhook_receipts WHERE dedupe_key LIKE $1 OR payload::text LIKE $2", [`%evt_T3sep${tag}%`, `%${tag}%`]),
    jobs: await one("SELECT count(*) AS n FROM jobs WHERE tenant_id=$1 OR (type='billing.event' AND created_at > now() - interval '1 minute')", [account]),
    invoices: await one('SELECT count(*) AS n FROM invoices WHERE account_id=$1', [account]),
  };
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('commerce payments and SaaS billing stay apart on PostgreSQL', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'T3 sep','test-only-hash')", [user, `${user}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'T3 separation',$2)", [account, user]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [account]);
      await owner.query('DELETE FROM webhook_receipts WHERE payload::text LIKE $1', [`%${tag}%`]);
      await owner.query('DELETE FROM billing_events WHERE event_id LIKE $1', [`evt_T3sep${tag}%`]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [account]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [user]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('no foreign key joins a SaaS billing table to a commerce table, in either direction', async () => {
    const fks = (await owner.query(`SELECT c.conrelid::regclass::text AS source, c.confrelid::regclass::text AS target
      FROM pg_constraint c WHERE c.contype='f' AND c.connamespace='public'::regnamespace`)).rows as { source: string; target: string }[];
    expect(fks.length).toBeGreaterThan(10);
    const tables = new Set((await owner.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map((r) => r.tablename));
    for (const t of [...SAAS, ...COMMERCE]) expect(tables.has(t), t).toBe(true);
    const crossing = fks.filter((f) => (SAAS.includes(f.source) && isCommerce(f.target)) || (isCommerce(f.source) && SAAS.includes(f.target)));
    expect(crossing).toEqual([]);
  });

  it('a commerce event signed with the billing secret reaches the billing webhook and creates nothing anywhere', async () => {
    const before = await counts();
    const res = await billingWebhook(request('http://localhost/api/billing/webhook', paymentLinkPaid, BILLING_SECRET, `evt_T3sep${tag}_1`));
    expect(res.status).toBe(200);
    expect(await counts()).toEqual(before);
  });

  it('a subscription event signed with the commerce secret reaches the commerce webhook and creates nothing anywhere', async () => {
    const before = await counts();
    const res = await commerceWebhook(request(`http://localhost/api/payments/razorpay/webhook/${account}`, subscriptionCharged, COMMERCE_SECRET, `evt_T3sep${tag}_2`),
      { params: Promise.resolve({ accountId: account }) });
    expect(res.status).toBe(200);
    expect(await counts()).toEqual(before);
  });

  it('each webhook refuses the other\'s signature', async () => {
    const before = await counts();
    expect((await billingWebhook(request('http://localhost/api/billing/webhook', subscriptionCharged, COMMERCE_SECRET, `evt_T3sep${tag}_3`))).status).toBe(401);
    expect((await commerceWebhook(request(`http://localhost/api/payments/razorpay/webhook/${account}`, paymentLinkPaid, BILLING_SECRET, `evt_T3sep${tag}_4`),
      { params: Promise.resolve({ accountId: account }) })).status).toBe(401);
    expect(await counts()).toEqual(before);
  });

  it('control: the same commerce event signed with the commerce secret is recorded by the commerce webhook only', async () => {
    const before = await counts();
    const res = await commerceWebhook(request(`http://localhost/api/payments/razorpay/webhook/${account}`, paymentLinkPaid, COMMERCE_SECRET, `evt_T3sep${tag}_5`),
      { params: Promise.resolve({ accountId: account }) });
    expect(res.status).toBe(200);
    expect(await counts()).toEqual({ ...before, receipts: before.receipts + 1, jobs: before.jobs + 1 });
  });
});
