import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { getEntitlements } from './entitlements';
import { financialYear, nextInvoiceNumber } from './invoice-number';
import { listPlanPrices, PriceInputError, upsertPlanPrices } from './prices';
import { currentUsage, incrementUsage } from './usage';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const seed = String(Date.now()).slice(-8);
const plan = `bill_${randomUUID().slice(0, 8)}`;
const subId = `sub_T${seed}`;
const as = (accountId: string, userId: string, role: TenantContext['role']): TenantContext => ({ accountId, userId, role });
const admin = as(accountA, adminA, 'admin'), agent = as(accountA, agentA, 'agent'), viewer = as(accountA, viewerA, 'viewer');
const otherOwner = as(accountB, ownerB, 'owner');
// A far-future financial year, so numbering here never meets real or other test invoices.
const invoiceDate = new Date('2091-07-15T12:00:00+05:30');
const fy = financialYear(invoiceDate);
let owner: pg.Client;

const insertInvoice = (ctx: TenantContext, number: string, extra = '') =>
  withTenant(ctx, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO invoices(number,subtotal_minor,igst_minor,total_minor,place_of_supply_state_code${extra ? ',status' : ''})
     VALUES($1,100000,18000,118000,'27'${extra ? `,'${extra}'` : ''})`, number), getWorkerPrisma());

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('billing foundation on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Billing test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, agentA, viewerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Billing A',$2),($3,'Billing B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')", [accountA, adminA, agentA, viewerA, accountB, ownerB]);
    await owner.query(`INSERT INTO plans(id,name,features,limits) VALUES($1,'Bill','{}','{"seats":2,"ai_messages":10,"whatsapp_numbers":1}')`, [plan]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM billing_events WHERE event_id LIKE $1', [`evt_${seed}%`]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[adminA, agentA, viewerA, ownerB]]);
      await owner.query('DELETE FROM plan_prices WHERE plan=$1', [plan]);
      await owner.query('DELETE FROM plans WHERE id=$1', [plan]);
      await owner.query('DELETE FROM invoice_sequences WHERE financial_year=$1', [fy]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('lets every signed-in role read plan prices but only the worker write them', async () => {
    const t1 = `plan_T1${seed}`, t2 = `plan_T2${seed}`;
    await upsertPlanPrices([{ plan, interval: 'month', currency: 'INR', amountMinor: 49_900, provider: 'razorpay', providerPlanId: t1, active: true }]);
    await upsertPlanPrices([{ plan, interval: 'month', currency: 'INR', amountMinor: 59_900, provider: 'razorpay', providerPlanId: t2, active: true }]);
    const prices = await withTenant(viewer, (tx) => listPlanPrices(tx));
    expect(prices.filter((p) => p.plan === plan)).toEqual([{ plan, interval: 'month', currency: 'INR', amountMinor: 59_900 }]);
    // A price change keeps the old provider plan (inactive), so subscriptions created on it still map to the plan.
    const rows = async () => (await owner.query('SELECT provider_plan_id, amount_minor::int AS amount, active FROM plan_prices WHERE plan=$1 ORDER BY provider_plan_id', [plan])).rows;
    expect(await rows()).toEqual([{ provider_plan_id: t1, amount: 49_900, active: false }, { provider_plan_id: t2, amount: 59_900, active: true }]);
    // Re-activating the old provider plan retires the current one; the same provider plan updates in place.
    await upsertPlanPrices([{ plan, interval: 'month', currency: 'INR', amountMinor: 49_000, provider: 'razorpay', providerPlanId: t1, active: true }]);
    expect(await rows()).toEqual([{ provider_plan_id: t1, amount: 49_000, active: true }, { provider_plan_id: t2, amount: 59_900, active: false }]);
    // One provider plan never maps to two prices, and at most one row per plan + interval is active.
    await expect(upsertPlanPrices([{ plan, interval: 'year', currency: 'INR', amountMinor: 1, provider: 'razorpay', providerPlanId: t1, active: true }]))
      .rejects.toBeInstanceOf(PriceInputError);
    await expect(owner.query('UPDATE plan_prices SET active=true WHERE plan=$1', [plan])).rejects.toThrow(/plan_prices_one_active/);
    await expect(getPrisma().$executeRawUnsafe(`INSERT INTO plan_prices(plan,"interval",amount_minor,provider_plan_id) VALUES($1,'year',1,'plan_X')`, plan))
      .rejects.toThrow(/permission denied/);
    await expect(upsertPlanPrices([{ plan: 'no_such_plan', interval: 'year', currency: 'INR', amountMinor: 1, provider: 'razorpay', providerPlanId: 'plan_X', active: true }]))
      .rejects.toBeInstanceOf(PriceInputError);
  });

  it('numbers invoices without gaps or duplicates under concurrency, per financial year', async () => {
    const numbers = await Promise.all(Array.from({ length: 12 }, () =>
      withTenant({ accountId: accountA }, async (tx) => {
        const number = await nextInvoiceNumber(tx, invoiceDate);
        await tx.$executeRaw`INSERT INTO invoices(number,subtotal_minor,cgst_minor,sgst_minor,total_minor,place_of_supply_state_code)
          VALUES(${number},100000,9000,9000,118000,'29')`;
        return number;
      }, getWorkerPrisma())));
    expect(new Set(numbers).size).toBe(12);
    expect(numbers.map((n) => Number(n.split('/')[2])).sort((x, y) => x - y)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(numbers[0]).toMatch(new RegExp(`^BX/${fy}/0000\\d\\d$`));
    // A rolled-back invoice releases its number.
    await expect(withTenant({ accountId: accountA }, async (tx) => {
      await nextInvoiceNumber(tx, invoiceDate);
      throw new Error('abandon');
    }, getWorkerPrisma())).rejects.toThrow('abandon');
    expect(await withTenant({ accountId: accountA }, (tx) => nextInvoiceNumber(tx, invoiceDate), getWorkerPrisma())).toBe(`BX/${fy}/000013`);
  });

  it('shows invoices to members of their own workspace only, written by the worker', async () => {
    await insertInvoice({ accountId: accountA }, `BX/${fy}/900001`);
    const seen = await withTenant(viewer, (tx) => tx.$queryRaw<{ number: string }[]>`SELECT number FROM invoices WHERE number=${`BX/${fy}/900001`}`);
    expect(seen).toHaveLength(1);
    expect(await withTenant(otherOwner, (tx) => tx.$queryRaw<unknown[]>`SELECT 1 FROM invoices WHERE account_id=${accountA}::uuid`)).toHaveLength(0);
    await expect(withTenant(admin, (tx) => tx.$executeRaw`INSERT INTO invoices(number,subtotal_minor,total_minor) VALUES(${`BX/${fy}/900002`},1,1)`))
      .rejects.toThrow(/permission denied/);
    await expect(withTenant(admin, (tx) => tx.$executeRaw`UPDATE invoices SET status='paid', paid_at=now()`)).rejects.toThrow(/permission denied/);
    // The worker cannot write into another workspace from this tenant scope.
    await expect(withTenant({ accountId: accountB }, (tx) => tx.$executeRaw`INSERT INTO invoices(account_id,number,subtotal_minor,total_minor)
      VALUES(${accountA}::uuid,${`BX/${fy}/900003`},1,1)`, getWorkerPrisma())).rejects.toThrow(/row-level security/);
    // Amounts must add up; 'paid' needs paid_at; never both IGST and CGST.
    await expect(withTenant({ accountId: accountA }, (tx) => tx.$executeRaw`INSERT INTO invoices(number,subtotal_minor,igst_minor,total_minor)
      VALUES(${`BX/${fy}/900004`},100,18,100)`, getWorkerPrisma())).rejects.toThrow(/check constraint/);
    await expect(insertInvoice({ accountId: accountA }, `BX/${fy}/900005`, 'paid')).rejects.toThrow(/check constraint/);
    await expect(withTenant({ accountId: accountA }, (tx) => tx.$executeRaw`INSERT INTO invoices(number,subtotal_minor,cgst_minor,igst_minor,total_minor)
      VALUES(${`BX/${fy}/900006`},100,9,18,127)`, getWorkerPrisma())).rejects.toThrow(/check constraint/);
  });

  it('counts metered usage atomically under concurrency, per workspace', async () => {
    const totals = await Promise.all(Array.from({ length: 20 }, () => withTenant(agent, (tx) => incrementUsage(tx, 'ai_messages'))));
    expect(Math.max(...totals)).toBe(20);
    expect(new Set(totals).size).toBe(20);
    await withTenant({ accountId: accountA }, (tx) => incrementUsage(tx, 'ai_messages', 5), getWorkerPrisma());
    await expect(withTenant(agent, (tx) => tx.$queryRaw`SELECT billing_increment_usage('ai_messages', -5)`)).rejects.toThrow(/positive/);
    await expect(withTenant(agent, (tx) => tx.$queryRaw`SELECT billing_increment_usage('bogus', 1)`)).rejects.toThrow(/check constraint/);
    await expect(withTenant(agent, (tx) => tx.$executeRaw`DELETE FROM usage_counters`)).rejects.toThrow(/permission denied/);
    const rows = await withTenant(otherOwner, (tx) => tx.$queryRaw<unknown[]>`SELECT 1 FROM usage_counters WHERE account_id=${accountA}::uuid`);
    expect(rows).toHaveLength(0);

    const contact = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Usage') RETURNING id", [accountA, adminA, `9177${seed}`])).rows[0].id;
    const stale = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Stale') RETURNING id", [accountA, adminA, `9178${seed}`])).rows[0].id;
    for (const [contactId, at] of [[contact, 'now()'], [stale, "now() - interval '70 days'"]]) {
      const conv = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id', [accountA, adminA, contactId])).rows[0].id;
      await owner.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,created_at) VALUES($1,$2,'agent','text','x','sent',${at})`, [accountA, conv]);
    }
    await owner.query("INSERT INTO media_objects(account_id,bucket,object_key,content_type,byte_size) VALUES($1,'b',$2,'image/png',3000000000),($1,'b',$3,'image/png',5)", [accountA, `k1-${seed}`, `k2-${seed}`]);
    await owner.query("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token,status) VALUES($1,$2,$3,'unused','connected')", [accountA, adminA, `77${seed}`]);
    const usage = await withTenant(viewer, (tx) => currentUsage(tx, accountA));
    expect(usage).toMatchObject({ ai_messages: 25, monthly_active_contacts: 1, storage_bytes: 3_000_000_005, whatsapp_numbers: 1, seats: 3 });
  });

  it('keeps billing profiles to admins and enforces the GSTIN format', async () => {
    await withTenant(admin, (tx) => tx.$executeRaw`INSERT INTO billing_profiles(legal_name,gstin,address_line1,city,state_code,postal_code,email)
      VALUES('Acme Pvt Ltd','27AAPFU0939F1ZV','1 MG Road','Pune','27','411001','billing@acme.example')`);
    expect(await withTenant(agent, (tx) => tx.$queryRaw<unknown[]>`SELECT 1 FROM billing_profiles`)).toHaveLength(0);
    expect(await withTenant(otherOwner, (tx) => tx.$queryRaw<unknown[]>`SELECT 1 FROM billing_profiles`)).toHaveLength(0);
    await expect(withTenant(agent, (tx) => tx.$executeRaw`UPDATE billing_profiles SET legal_name='x'`)).resolves.toBe(0);
    await expect(withTenant(admin, (tx) => tx.$executeRaw`UPDATE billing_profiles SET gstin='27AAPFU0939F1Z'`)).rejects.toThrow(/check constraint/);
    await expect(withTenant(admin, (tx) => tx.$executeRaw`UPDATE billing_profiles SET country='US', state_code=NULL`)).rejects.toThrow(/check constraint/);
  });

  it('applies the subscription status and add-ons to entitlements for every role', async () => {
    await owner.query("INSERT INTO account_subscriptions(account_id,plan_id,provider,provider_subscription_id,status) VALUES($1,$2,'razorpay',$3,'active')", [accountA, plan, subId]);
    await withTenant({ accountId: accountA }, (tx) => tx.$executeRaw`INSERT INTO add_ons(kind,quantity) VALUES('extra_seats',3),('ai_messages',100),('extra_numbers',2)`, getWorkerPrisma());
    await withTenant({ accountId: accountA }, (tx) => tx.$executeRaw`INSERT INTO add_ons(kind,quantity,status) VALUES('extra_seats',50,'cancelled')`, getWorkerPrisma());
    const e = await withTenant(agent, (tx) => getEntitlements(tx, accountA));
    expect(e.planId).toBe(plan);
    expect(e.limits).toMatchObject({ seats: 5, ai_messages: 110, whatsapp_numbers: 3, segments: null });
    // Add-on rows themselves are admin-only; the app never writes them.
    expect(await withTenant(agent, (tx) => tx.$queryRaw<unknown[]>`SELECT 1 FROM add_ons`)).toHaveLength(0);
    expect(await withTenant(admin, (tx) => tx.$queryRaw<unknown[]>`SELECT 1 FROM add_ons`)).toHaveLength(4);
    await expect(withTenant(admin, (tx) => tx.$executeRaw`INSERT INTO add_ons(kind,quantity) VALUES('extra_seats',1)`)).rejects.toThrow(/permission denied/);
    // Another workspace's add-ons never count.
    expect((await withTenant(otherOwner, (tx) => getEntitlements(tx, accountB))).planId).toBe('enterprise');

    // Only the worker changes a subscription; grace keeps the plan, suspended drops to free.
    await expect(withTenant(admin, (tx) => tx.$executeRaw`UPDATE account_subscriptions SET plan_id='enterprise'`)).rejects.toThrow(/permission denied/);
    const worker = (status: string) => withTenant({ accountId: accountA }, (tx) => tx.$executeRaw`UPDATE account_subscriptions SET status=${status}`, getWorkerPrisma());
    await worker('grace');
    expect((await withTenant(agent, (tx) => getEntitlements(tx, accountA))).planId).toBe(plan);
    await worker('suspended');
    expect((await withTenant(agent, (tx) => getEntitlements(tx, accountA))).planId).toBe('free');
    await expect(worker('canceled')).rejects.toThrow(/check constraint/);
    expect(await withTenant({ accountId: accountB }, (tx) => tx.$executeRaw`UPDATE account_subscriptions SET status='active' WHERE account_id=${accountA}::uuid`, getWorkerPrisma())).toBe(0);

    const [{ account }] = await getWorkerPrisma().$queryRaw<{ account: string }[]>`SELECT crm_resolve_billing_subscription('razorpay', ${subId}) AS account`;
    expect(account).toBe(accountA);
    await expect(getPrisma().$queryRaw`SELECT crm_resolve_billing_subscription('razorpay', ${subId})`).rejects.toThrow(/permission denied/);
    const sweep = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`SELECT account_id FROM crm_accounts_for_billing_sweep()`;
    expect(sweep.map((r) => r.account_id)).not.toContain(accountA);
  });

  it('keeps billing events worker-only and unique per provider event id', async () => {
    const insert = () => getWorkerPrisma().$executeRaw`INSERT INTO billing_events(provider,event_id,type,payload) VALUES('razorpay',${`evt_${seed}`},'subscription.charged','{}')`;
    await insert();
    await expect(insert()).rejects.toThrow(/unique/i);
    await expect(withTenant(admin, (tx) => tx.$queryRaw`SELECT 1 FROM billing_events`)).rejects.toThrow(/permission denied/);
  });

  it('adds archive flags for downgrade without touching rows', async () => {
    const { rows } = await owner.query(`SELECT table_name FROM information_schema.columns WHERE column_name='archived_at'
      AND table_name IN ('tags','segments','contact_lists','flows','automations') ORDER BY table_name`);
    expect(rows.map((r: { table_name: string }) => r.table_name)).toEqual(['automations', 'contact_lists', 'flows', 'segments', 'tags']);
  });
});
