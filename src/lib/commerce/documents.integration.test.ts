import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { getCommerceDocument, handleIssueCreditNoteJob, handleIssueReceiptJob } from './documents';

// Receipts and credit notes on PostgreSQL (design §3, test 9): concurrent
// receipts get gap-free numbers per workspace and year, a re-run returns the
// same document, totals and the CGST/SGST or IGST split equal the order
// snapshot, a credit note carries its tax share, and documents are
// read-only for every role and invisible to viewers.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, viewerA, ownerB];
const contactA = randomUUID();
const asOwner: TenantContext = { accountId: accountA, userId: ownerA, role: 'owner' };
const asViewer: TenantContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asOtherOwner: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const N = 8;
const orders = Array.from({ length: N }, () => randomUUID());
const payments = Array.from({ length: N }, () => randomUUID());
const interOrder = randomUUID(), interPayment = randomUUID();
const legacyOrder = randomUUID(), legacyPayment = randomUUID();
const pendingPayment = randomUUID();
const refundPartial = randomUUID(), refundFull = randomUUID();
let db: pg.Client;

const ADDRESS = (state: string) => JSON.stringify({ name: 'Asha', phone: '+919800000000', line1: '1 MG Road', city: 'Bengaluru',
  state: 'KA', state_code: state, postal_code: '560001', country: 'IN' });

async function pricedOrder(id: string, payment: string, state: string) {
  // 2 x 499.00 inclusive of 18% tax + 50.00 shipping = 1048.00; tax 159.86 (snapshot as priced).
  await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,discount_minor,shipping_minor,tax_minor,
      tax_inclusive,total_minor,status,priced_at,shipping_address,amount_paid_minor,paid_at)
    VALUES($1,$2,'storefront',$3,'INR',99800,0,5000,15986,true,104800,'paid',now(),$4::jsonb,104800,now())`, [id, accountA, contactA, ADDRESS(state)]);
  await db.query(`INSERT INTO order_items(account_id,order_id,name,sku,hsn_code,quantity,unit_price_minor,currency,tax_rate_bps,tax_minor,
      discount_minor,line_total_minor) VALUES($1,$2,'Ashwagandha 60','ASH-60','30049011',2,49900,'INR',1800,15223,0,99800)`, [accountA, id]);
  await db.query(`INSERT INTO customer_payments(id,account_id,source,provider_payment_id,order_id,amount_minor,currency,status,captured_at,settlement)
    VALUES($1,$2,'razorpay',$3,$4,104800,'INR','captured',now(),'settled')`, [payment, accountA, `pay_${payment.replace(/-/g, '').slice(0, 14)}`, id]);
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('commerce documents on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P8 docs', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Docs A',$2),($3,'Docs B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'viewer'),($4,$5,'owner')`,
      [accountA, ownerA, viewerA, accountB, ownerB]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Asha <b>','14155550901')", [contactA, accountA, ownerA]);
    await db.query(`INSERT INTO commerce_settings(account_id,currency,default_tax_rate_bps,legal_name,gstin,address,state_code,document_prefix)
      VALUES($1,'INR',1800,'Veda Herbs Pvt Ltd','29ABCDE1234F1Z5','Bengaluru','29','VH')`, [accountA]);
    await db.query(`INSERT INTO workspace_inbox_settings(account_id,timezone) VALUES($1,'Asia/Kolkata')`, [accountA]);
    for (let i = 0; i < N; i++) await pricedOrder(orders[i], payments[i], '29');
    await pricedOrder(interOrder, interPayment, '27');
    await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,total_minor,status)
      VALUES($1,$2,'whatsapp',$3,'INR',30000,30000,'confirmed')`, [legacyOrder, accountA, contactA]);
    await db.query(`INSERT INTO order_items(account_id,order_id,retailer_id,name,quantity,unit_price_minor,currency)
      VALUES($1,$2,'SKU-1','Tulsi tea',3,10000,'INR')`, [accountA, legacyOrder]);
    await db.query(`INSERT INTO customer_payments(id,account_id,source,order_id,amount_minor,currency,status,captured_at,settlement,offline_reference)
      VALUES($1,$2,'offline',$3,30000,'INR','captured',now(),'settled','CASH-1'),
            ($4,$2,'offline',$3,30000,'INR','captured',now(),'exception','CASH-2')`, [legacyPayment, accountA, legacyOrder, pendingPayment]);
    await db.query(`INSERT INTO customer_refunds(id,account_id,payment_id,order_id,source,amount_minor,currency,reason_code,status,processed_at)
      VALUES($1,$2,$3,$4,'bodhinox',20000,'INR','customer_request','processed',now()),
            ($5,$2,$6,$7,'bodhinox',104800,'INR','cancelled','processed',now())`,
      [refundPartial, accountA, payments[0], orders[0], refundFull, payments[1], orders[1]]);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('numbers concurrent receipts gap-free and returns the same document on a re-run', async () => {
    // Separate connections, all at once.
    await Promise.all(payments.map((paymentId) => handleIssueReceiptJob(accountA, { paymentId })));
    await Promise.all(payments.slice(0, 3).map((paymentId) => handleIssueReceiptJob(accountA, { paymentId })));
    const docs = (await db.query(`SELECT number, fy, payment_id FROM commerce_documents WHERE account_id=$1 AND kind='receipt'`, [accountA])).rows;
    expect(docs).toHaveLength(N);
    const fy = docs[0].fy;
    expect(fy).toMatch(/^\d{4}-\d{2}$/);
    const seqs = docs.map((d) => Number(d.number.split('/')[2])).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(docs.every((d) => d.number.startsWith(`VH/${fy}/`))).toBe(true);
    expect((await db.query('SELECT next_number FROM commerce_document_sequences WHERE account_id=$1', [accountA])).rows)
      .toEqual([{ next_number: N + 1 }]);
    const events = (await db.query(`SELECT count(*)::int AS n FROM order_events WHERE account_id=$1 AND kind='document_issued'`, [accountA])).rows[0].n;
    expect(events).toBe(N);
  });

  it('copies the frozen snapshot and splits GST by the seller and delivery states', async () => {
    await handleIssueReceiptJob(accountA, { paymentId: interPayment });
    const intra = (await db.query(`SELECT * FROM commerce_documents WHERE payment_id=$1`, [payments[2]])).rows[0];
    expect(intra).toMatchObject({ kind: 'receipt', currency: 'INR', subtotal_minor: '99800', discount_minor: '0', shipping_minor: '5000',
      tax_minor: '15986', cgst_minor: '7993', sgst_minor: '7993', igst_minor: '0', total_minor: '104800' });
    expect(intra.seller).toMatchObject({ legal_name: 'Veda Herbs Pvt Ltd', gstin: '29ABCDE1234F1Z5', state_code: '29' });
    expect(intra.buyer).toEqual({ name: 'Asha <b>' });
    expect(intra.address).not.toHaveProperty('phone');
    expect(intra.line_items).toEqual([expect.objectContaining({ name: 'Ashwagandha 60', sku: 'ASH-60', hsn_code: '30049011', quantity: 2,
      unit_price_minor: 49900, tax_rate_bps: 1800, tax_minor: 15223, line_total_minor: 99800 })]);
    const inter = (await db.query(`SELECT cgst_minor, sgst_minor, igst_minor FROM commerce_documents WHERE payment_id=$1`, [interPayment])).rows[0];
    expect(inter).toEqual({ cgst_minor: '0', sgst_minor: '0', igst_minor: '15986' });
  });

  it('prints a legacy unpriced order without tax and skips payments that did not settle', async () => {
    await handleIssueReceiptJob(accountA, { paymentId: legacyPayment });
    await handleIssueReceiptJob(accountA, { paymentId: pendingPayment });
    const rows = (await db.query(`SELECT payment_id, subtotal_minor, tax_minor, total_minor FROM commerce_documents WHERE order_id=$1`, [legacyOrder])).rows;
    expect(rows).toEqual([{ payment_id: legacyPayment, subtotal_minor: '30000', tax_minor: '0', total_minor: '30000' }]);
  });

  it('issues one credit note per processed refund with its tax share', async () => {
    await Promise.all([handleIssueCreditNoteJob(accountA, { refundId: refundPartial }), handleIssueCreditNoteJob(accountA, { refundId: refundPartial })]);
    await handleIssueCreditNoteJob(accountA, { refundId: refundFull });
    const partial = (await db.query(`SELECT kind, total_minor, tax_minor, subtotal_minor, cgst_minor, sgst_minor, order_id FROM commerce_documents
      WHERE refund_id=$1`, [refundPartial])).rows;
    // 200.00 of 1048.00 carrying 159.86 tax: round(20000 * 15986 / 104800) = 3051.
    expect(partial).toEqual([{ kind: 'credit_note', total_minor: '20000', tax_minor: '3051', subtotal_minor: '16949', cgst_minor: '1526',
      sgst_minor: '1525', order_id: orders[0] }]);
    const full = (await db.query(`SELECT tax_minor, total_minor FROM commerce_documents WHERE refund_id=$1`, [refundFull])).rows[0];
    expect(full).toEqual({ tax_minor: '15986', total_minor: '104800' });
  });

  it('issues no credit note for a payment that never got a receipt', async () => {
    // pendingPayment settled as an exception (no receipt); an unattached payment has no order at all.
    const unattached = randomUUID();
    await db.query(`INSERT INTO customer_payments(id,account_id,source,provider_payment_id,amount_minor,currency,status,captured_at,settlement)
      VALUES($1,$2,'razorpay',$3,5000,'INR','captured',now(),'unattached')`, [unattached, accountA, `pay_${unattached.replace(/-/g, '').slice(0, 14)}`]);
    const onException = randomUUID(), onUnattached = randomUUID();
    await db.query(`INSERT INTO customer_refunds(id,account_id,payment_id,order_id,source,amount_minor,currency,reason_code,status,processed_at)
      VALUES($1,$2,$3,$4,'bodhinox',30000,'INR','duplicate','processed',now()),
            ($5,$2,$6,NULL,'bodhinox',5000,'INR','other','processed',now())`, [onException, accountA, pendingPayment, legacyOrder, onUnattached, unattached]);
    const before = (await db.query('SELECT next_number FROM commerce_document_sequences WHERE account_id=$1', [accountA])).rows;
    await handleIssueCreditNoteJob(accountA, { refundId: onException });
    await handleIssueCreditNoteJob(accountA, { refundId: onUnattached });
    expect((await db.query('SELECT count(*)::int AS n FROM commerce_documents WHERE refund_id=ANY($1::uuid[])', [[onException, onUnattached]])).rows[0].n).toBe(0);
    // No series number is used up.
    expect((await db.query('SELECT next_number FROM commerce_document_sequences WHERE account_id=$1', [accountA])).rows).toEqual(before);
  });

  it('reverses exactly the order tax across partial credit notes', async () => {
    // orders[3]: 1048.00 carrying 159.86 tax, receipted; refunded as 300.00 + 300.00 + 448.00.
    const parts = [30000, 30000, 44800].map((amount) => ({ id: randomUUID(), amount }));
    for (const p of parts) {
      await db.query(`INSERT INTO customer_refunds(id,account_id,payment_id,order_id,source,amount_minor,currency,reason_code,status,processed_at)
        VALUES($1,$2,$3,$4,'bodhinox',$5,'INR','customer_request','processed',now())`, [p.id, accountA, payments[3], orders[3], p.amount]);
    }
    await Promise.all(parts.map((p) => handleIssueCreditNoteJob(accountA, { refundId: p.id })));
    const notes = (await db.query(`SELECT tax_minor::int AS tax, total_minor::int AS total FROM commerce_documents
      WHERE kind='credit_note' AND order_id=$1`, [orders[3]])).rows;
    expect(notes).toHaveLength(3);
    expect(notes.reduce((sum, n) => sum + n.total, 0)).toBe(104800);
    expect(notes.reduce((sum, n) => sum + n.tax, 0)).toBe(15986);
  });

  it('keeps documents read-only, tenant-scoped and hidden from viewers', async () => {
    const [id] = (await db.query(`SELECT id FROM commerce_documents WHERE payment_id=$1`, [payments[0]])).rows.map((r) => r.id);
    const doc = await getCommerceDocument(asOwner, id);
    expect(doc).toMatchObject({ id, kind: 'receipt', total_minor: 104800, tax_inclusive: true });
    expect(await getCommerceDocument(asViewer, id)).toBeNull();
    expect(await getCommerceDocument(asOtherOwner, id)).toBeNull();
    await expect(withTenant(asOwner, (tx) => tx.$executeRaw`UPDATE commerce_documents SET total_minor=1 WHERE id=${id}::uuid`)).rejects.toThrow();
    await expect(withTenant({ accountId: accountA, role: 'owner' },
      (tx) => tx.$executeRaw`UPDATE commerce_documents SET total_minor=1 WHERE id=${id}::uuid`, getWorkerPrisma())).rejects.toThrow();
    await expect(withTenant(asOwner, (tx) => tx.$executeRaw`INSERT INTO commerce_documents(account_id,kind,number,fy,currency,seller,buyer,
      line_items,subtotal_minor,total_minor) VALUES(${accountA}::uuid,'receipt','X/2026-27/99','2026-27','INR','{}','{}','[]',0,0)`)).rejects.toThrow();
  });
});
