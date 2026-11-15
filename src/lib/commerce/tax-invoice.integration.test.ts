import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gstinCheckChar } from '@/lib/billing/gst';
import { ForbiddenError } from '@/lib/auth/errors';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { placeOrder } from './checkout';
import { getCommerceDocument, handleIssueCreditNoteJob, handleIssueReceiptJob } from './documents';
import { OrderError } from './orders';
import { issueSessionTx, loadSession, quoteSessionTx, setAddressTx, setPaymentMethodTx, updateCartTx } from './storefront';
import { getOrderTaxInvoiceState, requestOrderTaxInvoice, setOrderBuyerTax } from './tax-invoice-orders';

// GST tax invoices on PostgreSQL (Store Phase 5): the buyer GSTIN is validated and stored at checkout; an order
// with a buyer GSTIN gets a tax invoice (not a receipt) in the workspace's gap-free series, once, with CGST+SGST
// inside the seller's state and IGST outside it; an order without one keeps its receipt; a workspace without a
// GSTIN issues no tax invoice; staff edit the buyer GSTIN until the invoice exists; workspaces never see each other.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const make = (first14: string) => first14 + gstinCheckChar(first14);
const GSTIN_KA = make('29AABCU9603R1Z');
const GSTIN_MH = '27AAPFU0939F1ZV';

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, agentA, viewerA, ownerB];
const contactA = randomUUID(), contactB = randomUUID();
const product = randomUUID(), variant = randomUUID();
const asOwnerA = { accountId: accountA, userId: ownerA, role: 'owner' as const };
const asAgentA = { accountId: accountA, userId: agentA, role: 'agent' as const };
const asViewerA = { accountId: accountA, userId: viewerA, role: 'viewer' as const };
const asOwnerB = { accountId: accountB, userId: ownerB, role: 'owner' as const };
let db: pg.Client;

const ADDRESS = (state: string, code: string) => ({ name: 'Asha', phone: '+919800000000', line1: '1 MG Road', city: 'City', state, state_code: code,
  postal_code: '560001', country: 'IN' });
const worker = <T,>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: accountA, role: 'owner' }, fn, getWorkerPrisma());

/** A paid, priced order (2 x 499.00 inclusive of 18% tax + 50.00 shipping = 1048.00, tax 159.86) with one settled payment. */
async function paidOrder(account: string, contact: string, buyerGstin: string | null, stateCode = '29', legalName: string | null = null) {
  const order = randomUUID(), payment = randomUUID();
  await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,discount_minor,shipping_minor,tax_minor,tax_inclusive,
      total_minor,status,priced_at,shipping_address,amount_paid_minor,paid_at,buyer_gstin,buyer_legal_name)
    VALUES($1,$2,'storefront',$3,'INR',99800,0,5000,15986,true,104800,'paid',now(),$4::jsonb,104800,now(),$5,$6)`,
  [order, account, contact, JSON.stringify(ADDRESS('X', stateCode)), buyerGstin, legalName]);
  await db.query(`INSERT INTO order_items(account_id,order_id,name,sku,hsn_code,quantity,unit_price_minor,currency,tax_rate_bps,tax_minor,
      discount_minor,line_total_minor) VALUES($1,$2,'Ashwagandha 60','ASH-60','30049011',2,49900,'INR',1800,15223,0,99800)`, [account, order]);
  await db.query(`INSERT INTO customer_payments(id,account_id,source,provider_payment_id,order_id,amount_minor,currency,status,captured_at,settlement)
    VALUES($1,$2,'razorpay',$3,$4,104800,'INR','captured',now(),'settled')`, [payment, account, `pay_${payment.replace(/-/g, '').slice(0, 14)}`, order]);
  return { order, payment };
}
const docsOf = async (order: string) => (await db.query('SELECT * FROM commerce_documents WHERE order_id=$1 ORDER BY issued_at, id', [order])).rows;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('GST tax invoices on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P5 GST', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'GST A',$2),($3,'GST B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [accountA]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')`,
      [accountA, ownerA, agentA, viewerA, accountB, ownerB]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Asha','14155550911'),($4,$5,$6,'Bela','14155550912')",
      [contactA, accountA, ownerA, contactB, accountB, ownerB]);
    // A: seller in Karnataka (29) with a GSTIN and COD on; B: no GSTIN.
    await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,reservation_minutes,
        cod_enabled,legal_name,gstin,address,state_code,document_prefix)
      VALUES($1,'INR',true,1800,true,15,true,'Veda Herbs Pvt Ltd',$2,'Bengaluru','29','VH')`, [accountA, GSTIN_KA]);
    await db.query("INSERT INTO commerce_settings(account_id,currency,legal_name,state_code,document_prefix) VALUES($1,'INR','Unregistered Co','29','UR')", [accountB]);
    await db.query("INSERT INTO workspace_inbox_settings(account_id,timezone) VALUES($1,'Asia/Kolkata'),($2,'Asia/Kolkata')", [accountA, accountB]);
    await db.query("INSERT INTO shipping_rates(account_id,name,country,fee_minor) VALUES($1,'India','IN',5000)", [accountA]);
    await db.query("INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at) VALUES($1,$2,'Triphala','published',now())", [product, accountA]);
    await db.query("INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,hsn_code) VALUES($1,$2,$3,'TRI-100',20000,'30049011')", [variant, accountA, product]);
    await db.query('INSERT INTO inventory_levels(account_id,variant_id,on_hand) VALUES($1,$2,100)', [accountA, variant]);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  async function session(address = ADDRESS('Karnataka', '29')) {
    const sessionId = randomUUID();
    await worker((tx) => issueSessionTx(tx, accountA, { sessionId, contactId: contactA, conversationId: null, whatsappConfigId: null, purpose: 'shop', orderId: null, ttlHours: 24, createdBy: null }));
    await worker((tx) => updateCartTx(tx, accountA, sessionId, { expectedVersion: 1, lines: [{ variantId: variant, qty: 1 }] }));
    await worker((tx) => setAddressTx(tx, accountA, sessionId, { expectedVersion: 2, address }));
    await worker((tx) => setPaymentMethodTx(tx, accountA, sessionId, { expectedVersion: 3, paymentMethod: 'cod' }));
    const quote = await worker(async (tx) => (await quoteSessionTx(tx, accountA, (await loadSession(tx, accountA, sessionId))!)).result);
    if (!quote.ok) throw new Error(`quote refused: ${quote.code}`);
    return { sessionId, version: 4, total: quote.quote.totalMinor };
  }
  const place = (s: Awaited<ReturnType<typeof session>>, extra: Record<string, unknown> = {}) =>
    placeOrder(accountA, s.sessionId, { expectedVersion: s.version, expectedTotalMinor: s.total, clientRequestId: randomUUID(), ...extra });

  it('stores a valid buyer GSTIN and legal name at checkout, refuses a bad one before any order exists, and keeps null otherwise', async () => {
    const ok = await place(await session(), { buyerGstin: ` ${GSTIN_MH.toLowerCase()} `, buyerLegalName: '  Rao   Traders ' });
    expect((await db.query('SELECT buyer_gstin, buyer_legal_name FROM orders WHERE id=$1', [ok.orderId])).rows[0])
      .toEqual({ buyer_gstin: GSTIN_MH, buyer_legal_name: 'Rao Traders' });

    const bad = await session();
    for (const buyerGstin of [GSTIN_KA.slice(0, 14) + (GSTIN_KA[14] === 'A' ? 'B' : 'A'), make('99AABCU9603R1Y'), make('00AABCU9603R1Z'), 'short']) {
      await expect(place(bad, { buyerGstin })).rejects.toMatchObject({ code: 'invalid', detail: { field: 'buyer_gstin' } });
    }
    await expect(place(bad, { buyerLegalName: 'No GSTIN' })).rejects.toMatchObject({ code: 'invalid' });
    expect((await db.query('SELECT count(*)::int AS n FROM orders WHERE storefront_session_id=$1', [bad.sessionId])).rows[0].n).toBe(0);

    const plain = await place(await session());
    expect((await db.query('SELECT buyer_gstin, buyer_legal_name FROM orders WHERE id=$1', [plain.orderId])).rows[0]).toEqual({ buyer_gstin: null, buyer_legal_name: null });
  });

  it('issues a tax invoice instead of a receipt when the order has a buyer GSTIN, and a receipt when it has none', async () => {
    const withGstin = await paidOrder(accountA, contactA, GSTIN_KA, '29', 'Rao Traders');
    const without = await paidOrder(accountA, contactA, null);
    await handleIssueReceiptJob(accountA, { paymentId: withGstin.payment });
    await handleIssueReceiptJob(accountA, { paymentId: without.payment });
    const [invoice] = await docsOf(withGstin.order);
    expect(invoice).toMatchObject({ kind: 'tax_invoice', payment_id: withGstin.payment, total_minor: '104800', tax_minor: '15986',
      cgst_minor: '7993', sgst_minor: '7993', igst_minor: '0' });
    expect(invoice.buyer).toEqual({ name: 'Asha', gstin: GSTIN_KA, legal_name: 'Rao Traders', place_of_supply: '29' });
    expect(invoice.seller).toMatchObject({ legal_name: 'Veda Herbs Pvt Ltd', gstin: GSTIN_KA, state_code: '29' });
    expect(invoice.line_items).toEqual([expect.objectContaining({ hsn_code: '30049011', quantity: 2, tax_rate_bps: 1800, tax_minor: 15223,
      line_total_minor: 99800, taxable_minor: 84577 })]);
    const docs = await docsOf(without.order);
    expect(docs).toHaveLength(1);
    expect(docs[0].kind).toBe('receipt');
    expect(docs[0].buyer).toEqual({ name: 'Asha' });
    // The reader sees the buyer tax fields.
    expect((await getCommerceDocument(asOwnerA, invoice.id))?.buyer).toMatchObject({ gstin: GSTIN_KA, place_of_supply: '29' });
  });

  it('charges IGST outside the seller state, by the buyer GSTIN state rather than the shipping state', async () => {
    // Delivery in Karnataka (29), but the buyer is registered in Maharashtra (27): place of supply is 27.
    const inter = await paidOrder(accountA, contactA, GSTIN_MH, '29');
    await handleIssueReceiptJob(accountA, { paymentId: inter.payment });
    const [invoice] = await docsOf(inter.order);
    expect(invoice).toMatchObject({ kind: 'tax_invoice', cgst_minor: '0', sgst_minor: '0', igst_minor: '15986' });
    expect(invoice.buyer).toMatchObject({ place_of_supply: '27' });
  });

  it('numbers tax invoices gap-free in the workspace series, once per order, and independently per workspace', async () => {
    const batch = await Promise.all(Array.from({ length: 5 }, () => paidOrder(accountA, contactA, GSTIN_KA)));
    await Promise.all(batch.map((o) => handleIssueReceiptJob(accountA, { paymentId: o.payment })));
    await Promise.all(batch.slice(0, 2).map((o) => handleIssueReceiptJob(accountA, { paymentId: o.payment })));
    const all = (await db.query('SELECT number, kind FROM commerce_documents WHERE account_id=$1', [accountA])).rows;
    const seqs = all.map((d) => Number(d.number.split('/')[2])).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(all.every((d) => d.number.startsWith('VH/'))).toBe(true);
    for (const o of batch) expect((await docsOf(o.order)).map((d) => d.kind)).toEqual(['tax_invoice']);

    // Another workspace starts its own series at 1 (its seller has no GSTIN, so this is a receipt).
    const other = await paidOrder(accountB, contactB, GSTIN_KA);
    await handleIssueReceiptJob(accountB, { paymentId: other.payment });
    expect((await docsOf(other.order)).map((d) => d.number.split('/')[2])).toEqual(['1']);
  });

  it('is idempotent: a replay and a second payment of the same order return the one invoice', async () => {
    const o = await paidOrder(accountA, contactA, GSTIN_KA);
    const second = randomUUID();
    await db.query(`INSERT INTO customer_payments(id,account_id,source,provider_payment_id,order_id,amount_minor,currency,status,captured_at,settlement)
      VALUES($1,$2,'razorpay',$3,$4,100,'INR','captured',now(),'settled')`, [second, accountA, `pay_${second.replace(/-/g, '').slice(0, 14)}`, o.order]);
    await Promise.all([handleIssueReceiptJob(accountA, { paymentId: o.payment }), handleIssueReceiptJob(accountA, { paymentId: o.payment }),
      handleIssueReceiptJob(accountA, { paymentId: second })]);
    expect((await docsOf(o.order)).map((d) => d.kind)).toEqual(['tax_invoice']);
    const id = (await docsOf(o.order))[0].id;
    expect(await requestOrderTaxInvoice(asOwnerA, o.order)).toBe(id);
    expect(await requestOrderTaxInvoice(asAgentA, o.order)).toBe(id);
    expect((await db.query("SELECT count(*)::int AS n FROM commerce_documents WHERE order_id=$1 AND kind='tax_invoice'", [o.order])).rows[0].n).toBe(1);
    // The database refuses a second tax invoice for an order even when written directly.
    await expect(db.query(`INSERT INTO commerce_documents(account_id,order_id,kind,number,fy,currency,seller,buyer,line_items,subtotal_minor,total_minor)
      VALUES($1,$2,'tax_invoice','VH/2026-27/9999','2026-27','INR','{}','{}','[]',0,0)`, [accountA, o.order])).rejects.toThrow(/commerce_documents_tax_invoice_order_key/);
  });

  it('issues nothing for a COD order until staff ask, and then one invoice with the COD snapshot', async () => {
    const placed = await place(await session(), { buyerGstin: GSTIN_KA });
    expect(await docsOf(placed.orderId)).toEqual([]);
    const id = await requestOrderTaxInvoice(asAgentA, placed.orderId);
    const [doc] = await docsOf(placed.orderId);
    expect(doc).toMatchObject({ id, kind: 'tax_invoice', payment_id: null });
    expect(doc.line_items[0]).toMatchObject({ hsn_code: '30049011', sku: 'TRI-100' });
  });

  it('refuses the request without a buyer GSTIN, without a seller GSTIN, for an unpaid prepaid order, and for another workspace', async () => {
    const noBuyer = await paidOrder(accountA, contactA, null);
    await expect(requestOrderTaxInvoice(asOwnerA, noBuyer.order)).rejects.toMatchObject({ code: 'buyer_gstin_missing', status: 409 });

    // Workspace B has no GSTIN: no invoice from the job (a receipt instead) or from the request.
    const b = await paidOrder(accountB, contactB, GSTIN_KA);
    await expect(requestOrderTaxInvoice(asOwnerB, b.order)).rejects.toMatchObject({ code: 'seller_gstin_missing' });
    await handleIssueReceiptJob(accountB, { paymentId: b.payment });
    expect((await docsOf(b.order)).map((d) => d.kind)).toEqual(['receipt']);
    expect((await getOrderTaxInvoiceState(asOwnerB, b.order)).seller_gstin_configured).toBe(false);
    expect((await getOrderTaxInvoiceState(asOwnerA, noBuyer.order)).seller_gstin_configured).toBe(true);

    const unpaid = randomUUID();
    await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,total_minor,status,priced_at,tax_inclusive,buyer_gstin)
      VALUES($1,$2,'storefront',$3,'INR',100,100,'awaiting_payment',now(),true,$4)`, [unpaid, accountA, contactA, GSTIN_KA]);
    await expect(requestOrderTaxInvoice(asOwnerA, unpaid)).rejects.toMatchObject({ code: 'bad_transition' });

    // Tenancy: the other workspace's order is a 404 for A's staff, and A's for B's.
    await expect(requestOrderTaxInvoice(asOwnerA, b.order)).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(getOrderTaxInvoiceState(asOwnerB, noBuyer.order)).rejects.toMatchObject({ code: 'not_found' });
    await expect(setOrderBuyerTax(asOwnerB, noBuyer.order, { gstin: GSTIN_KA, legal_name: null })).rejects.toMatchObject({ code: 'not_found' });
    expect((await db.query('SELECT buyer_gstin FROM orders WHERE id=$1', [noBuyer.order])).rows[0].buyer_gstin).toBeNull();
  });

  it('lets agents set, change and clear the buyer GSTIN until the invoice exists; viewers cannot; a bad GSTIN is refused', async () => {
    const o = await paidOrder(accountA, contactA, null);
    await setOrderBuyerTax(asAgentA, o.order, { gstin: ` ${GSTIN_MH.toLowerCase()}`, legal_name: ' Rao  Traders ' });
    expect(await getOrderTaxInvoiceState(asAgentA, o.order)).toEqual({ buyer_gstin: GSTIN_MH, buyer_legal_name: 'Rao Traders', seller_gstin_configured: true, document_id: null });
    await setOrderBuyerTax(asOwnerA, o.order, { gstin: '', legal_name: '' });
    expect((await getOrderTaxInvoiceState(asOwnerA, o.order)).buyer_gstin).toBeNull();
    await expect(setOrderBuyerTax(asAgentA, o.order, { gstin: 'BADGSTIN', legal_name: null })).rejects.toMatchObject({ code: 'invalid_gstin', status: 400 });
    await expect(setOrderBuyerTax(asAgentA, o.order, { gstin: null, legal_name: 'Name only' })).rejects.toMatchObject({ code: 'invalid_gstin' });
    await expect(setOrderBuyerTax(asViewerA, o.order, { gstin: GSTIN_MH, legal_name: null })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requestOrderTaxInvoice(asViewerA, o.order)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await db.query('SELECT buyer_gstin FROM orders WHERE id=$1', [o.order])).rows[0].buyer_gstin).toBeNull();

    await setOrderBuyerTax(asAgentA, o.order, { gstin: GSTIN_MH, legal_name: null });
    const id = await requestOrderTaxInvoice(asAgentA, o.order);
    // Once issued the buyer details are locked and the invoice keeps the GSTIN it was issued with.
    await expect(setOrderBuyerTax(asOwnerA, o.order, { gstin: GSTIN_KA, legal_name: null })).rejects.toMatchObject({ code: 'invoice_issued', status: 409 });
    await expect(setOrderBuyerTax(asOwnerA, o.order, { gstin: null, legal_name: null })).rejects.toBeInstanceOf(OrderError);
    expect((await getOrderTaxInvoiceState(asAgentA, o.order)).document_id).toBe(id);
    expect((await docsOf(o.order))[0].buyer).toMatchObject({ gstin: GSTIN_MH });
    const events = (await db.query("SELECT detail FROM order_events WHERE order_id=$1 AND kind='buyer_tax_updated' ORDER BY created_at", [o.order])).rows;
    expect(events.map((e) => e.detail)).toEqual(['set', 'cleared', 'set']);
  });

  it('issues the credit note of a tax invoice with the same buyer and place of supply', async () => {
    const o = await paidOrder(accountA, contactA, GSTIN_MH, '29');
    await handleIssueReceiptJob(accountA, { paymentId: o.payment });
    const refund = randomUUID();
    await db.query(`INSERT INTO customer_refunds(id,account_id,payment_id,order_id,source,amount_minor,currency,reason_code,status,processed_at)
      VALUES($1,$2,$3,$4,'bodhinox',20000,'INR','customer_request','processed',now())`, [refund, accountA, o.payment, o.order]);
    await handleIssueCreditNoteJob(accountA, { refundId: refund });
    const note = (await docsOf(o.order)).find((d) => d.kind === 'credit_note');
    expect(note).toMatchObject({ tax_minor: '3051', igst_minor: '3051', cgst_minor: '0', sgst_minor: '0' });
    expect(note.buyer).toMatchObject({ gstin: GSTIN_MH, place_of_supply: '27' });
  });

  it('keeps the buyer GSTIN format guarded by the database', async () => {
    const o = await paidOrder(accountA, contactA, null);
    await expect(db.query('UPDATE orders SET buyer_gstin=$2 WHERE id=$1', [o.order, 'not-a-gstin'])).rejects.toThrow(/orders_buyer_gstin_check/);
    await expect(db.query('UPDATE orders SET buyer_gstin=$2, buyer_legal_name=$3 WHERE id=$1', [o.order, GSTIN_KA, 'x'.repeat(201)])).rejects.toThrow(/orders_buyer_legal_name_check/);
  });
});
