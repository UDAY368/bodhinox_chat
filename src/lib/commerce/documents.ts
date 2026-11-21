/**
 * Receipts and credit notes (design §3, T5). Numbers <prefix>/<FY>/<seq> from
 * commerce_document_sequences (one row per workspace and financial year,
 * incremented inside the issuing transaction, so numbers are gap-free: a
 * rolled-back issue rolls its number back too). FY runs April to March in the
 * workspace timezone. Totals and the GST split come from the order's frozen
 * snapshot. Never imports SaaS billing code (BIL-02).
 *
 * Receipts and credit notes share one series per workspace and year; the
 * title tells them apart.
 */
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { minorFromDb, mulDivHalfUp } from './money';
import { formatMoney } from '@/lib/format/money';
import { lineTaxableMinor, placeOfSupply as placeOfSupplyOf, taxInvoiceSplit } from './tax-invoice';

/**
 * commerce.issue_receipt — dedupe receipt:<paymentId>, queued by settlement. `orderId` instead (dedupe
 * receipt:order:<orderId>): an order paid in full with store credit and loyalty points, which has no payment row.
 */
export interface IssueReceiptJobPayload {
  paymentId?: string;
  orderId?: string;
}

/** commerce.issue_credit_note — dedupe credit:<refundId>, queued when a refund is processed. */
export interface IssueCreditNoteJobPayload {
  refundId: string;
}

export type DocumentErrorCode = 'not_found' | 'not_applicable' | 'seller_gstin_missing' | 'buyer_gstin_missing' | 'invoice_issued';
export class DocumentError extends Error {
  constructor(readonly code: DocumentErrorCode, message: string = code) {
    super(message);
    this.name = 'DocumentError';
  }
}

export type DocumentKind = 'receipt' | 'credit_note' | 'tax_invoice';

export interface DocumentLine {
  name: string;
  sku: string | null;
  hsn_code: string | null;
  quantity: number;
  unit_price_minor: number;
  discount_minor: number;
  tax_rate_bps: number | null;
  tax_minor: number;
  line_total_minor: number;
  /** Tax invoices only: the line's value before tax. */
  taxable_minor?: number;
}

export interface CommerceDocument {
  id: string;
  kind: DocumentKind;
  number: string;
  fy: string;
  currency: string;
  order_id: string | null;
  appointment_id: string | null;
  payment_id: string | null;
  refund_id: string | null;
  seller: { legal_name: string | null; gstin: string | null; address: string | null; state_code: string | null };
  /** gstin, legal_name and place_of_supply (a GST state code) are set on a tax invoice and on the credit note of one. */
  buyer: { name: string | null; gstin: string | null; legal_name: string | null; place_of_supply: string | null };
  address: Record<string, string> | null;
  line_items: DocumentLine[];
  subtotal_minor: number;
  discount_minor: number;
  shipping_minor: number;
  /** The cash-on-delivery fee (its tax is inside tax_minor); 0 when none. */
  cod_fee_minor: number;
  tax_minor: number;
  cgst_minor: number;
  sgst_minor: number;
  igst_minor: number;
  total_minor: number;
  tax_inclusive: boolean | null;
  issued_at: string;
}

// ---------------------------------------------------------------------------
// Pure helpers

/** Financial year (April to March) of `at` in `timeZone`, e.g. "2026-27". */
export function financialYear(at: Date, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric' }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'numeric' }).formatToParts(at);
  }
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function documentNumber(prefix: string, fy: string, seq: number): string {
  return `${prefix}/${fy}/${seq}`;
}

/**
 * GST split (design E4): intra-state supply in India is CGST + SGST
 * (sgst = floor(tax/2), cgst = the rest, so they sum exactly); inter-state is
 * IGST. Without both state codes, or outside India, no split is printed.
 */
export function gstSplit(taxMinor: number, sellerState: string | null, address: { country?: unknown; state_code?: unknown } | null) {
  const zero = { cgst_minor: 0, sgst_minor: 0, igst_minor: 0 };
  const buyerState = typeof address?.state_code === 'string' ? address.state_code.toUpperCase() : null;
  const country = typeof address?.country === 'string' ? address.country.toUpperCase() : null;
  if (taxMinor <= 0 || !sellerState || !buyerState || (country !== null && country !== 'IN')) return zero;
  if (sellerState.toUpperCase() !== buyerState) return { ...zero, igst_minor: taxMinor };
  const sgst = Math.floor(taxMinor / 2);
  return { cgst_minor: taxMinor - sgst, sgst_minor: sgst, igst_minor: 0 };
}

/**
 * The tax inside a refund of `amount` from a supply of `total` carrying `tax`,
 * after `priorRefunded` was already credited. Allocated cumulatively
 * (share of prior + amount minus share of prior), so the credit notes of one
 * order add up to exactly `tax` once `total` is refunded, whatever the split.
 */
export function refundTaxShare(amount: number, total: number, tax: number, priorRefunded = 0): number {
  if (total <= 0 || tax <= 0 || amount <= 0) return 0;
  const prior = Math.min(Math.max(priorRefunded, 0), total);
  const share = mulDivHalfUp(Math.min(prior + amount, total), tax, total) - mulDivHalfUp(prior, tax, total);
  return Math.max(0, Math.min(share, amount));
}

const ADDRESS_KEYS = ['name', 'line1', 'line2', 'city', 'state', 'state_code', 'postal_code', 'country'] as const;

/** The address printed on a document: shipping fields only (the phone is left out). */
export function documentAddress(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ADDRESS_KEYS) {
    const v = source[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim().slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// Issuing (worker transaction)

interface SellerRow {
  legal_name: string | null; gstin: string | null; address: string | null; state_code: string | null;
  document_prefix: string | null; account_name: string; timezone: string | null;
}

async function seller(tx: TenantTransaction, accountId: string): Promise<SellerRow> {
  const [row] = await tx.$queryRaw<SellerRow[]>`
    SELECT s.legal_name, s.gstin, s.address, s.state_code, s.document_prefix, a.name AS account_name, w.timezone
    FROM accounts a
    LEFT JOIN commerce_settings s ON s.account_id=a.id
    LEFT JOIN workspace_inbox_settings w ON w.account_id=a.id
    WHERE a.id=${accountId}::uuid`;
  if (!row) throw new DocumentError('not_found', 'Workspace not found');
  return row;
}

/** Take the next number of the workspace's series for `fy` (locks the sequence row until commit). */
async function nextNumber(tx: TenantTransaction, accountId: string, fy: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ n: number }[]>`
    INSERT INTO commerce_document_sequences(account_id, fy, next_number) VALUES(${accountId}::uuid, ${fy}, 2)
    ON CONFLICT (account_id, fy) DO UPDATE SET next_number = commerce_document_sequences.next_number + 1
    RETURNING (next_number - 1)::int AS n`;
  return row.n;
}

interface OrderSnapshot {
  id: string; contact_id: string | null; currency: string; subtotal_minor: bigint; discount_minor: bigint; shipping_minor: bigint;
  tax_minor: bigint; total_minor: bigint | null; tax_inclusive: boolean | null; priced_at: Date | null; shipping_address: unknown;
  cod_fee_minor: bigint; buyer_gstin: string | null; buyer_legal_name: string | null;
}

async function orderSnapshot(tx: TenantTransaction, accountId: string, orderId: string) {
  const [order] = await tx.$queryRaw<OrderSnapshot[]>`
    SELECT id, contact_id, currency, subtotal_minor, discount_minor, shipping_minor, tax_minor, total_minor, tax_inclusive,
      priced_at, shipping_address, cod_fee_minor, buyer_gstin, buyer_legal_name
    FROM orders WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid`;
  if (!order) return null;
  const items = await tx.$queryRaw<{
    name: string | null; retailer_id: string | null; sku: string | null; hsn_code: string | null; quantity: number;
    unit_price_minor: bigint; discount_minor: bigint | null; tax_rate_bps: number | null; tax_minor: bigint | null;
    line_total_minor: bigint | null;
  }[]>`
    SELECT name, retailer_id, sku, hsn_code, quantity, unit_price_minor, discount_minor, tax_rate_bps, tax_minor, line_total_minor
    FROM order_items WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid ORDER BY id`;
  const priced = order.priced_at !== null;
  const lines: DocumentLine[] = items.map((i) => {
    const gross = minorFromDb(i.unit_price_minor)! * i.quantity;
    return {
      name: (i.name || i.sku || i.retailer_id || '-').slice(0, 200),
      sku: i.sku, hsn_code: i.hsn_code, quantity: i.quantity, unit_price_minor: minorFromDb(i.unit_price_minor)!,
      discount_minor: priced ? minorFromDb(i.discount_minor) ?? 0 : 0,
      tax_rate_bps: priced ? i.tax_rate_bps : null,
      tax_minor: priced ? minorFromDb(i.tax_minor) ?? 0 : 0,
      line_total_minor: priced ? minorFromDb(i.line_total_minor) ?? gross : gross,
    };
  });
  // A legacy unpriced order has no tax or discount snapshot: it prints its lines and total only.
  const subtotal = minorFromDb(order.subtotal_minor)!;
  return {
    order, lines,
    subtotal_minor: subtotal,
    discount_minor: priced ? minorFromDb(order.discount_minor)! : 0,
    shipping_minor: priced ? minorFromDb(order.shipping_minor)! : 0,
    cod_fee_minor: priced ? minorFromDb(order.cod_fee_minor) ?? 0 : 0,
    tax_minor: priced ? minorFromDb(order.tax_minor)! : 0,
    total_minor: minorFromDb(order.total_minor) ?? subtotal,
    tax_inclusive: priced ? order.tax_inclusive : null,
  };
}

async function buyerName(tx: TenantTransaction, accountId: string, contactId: string | null): Promise<string | null> {
  if (!contactId) return null;
  const [row] = await tx.$queryRaw<{ name: string | null }[]>`
    SELECT name FROM contacts WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid`;
  return row?.name?.slice(0, 200) ?? null;
}

interface Draft {
  kind: DocumentKind;
  currency: string;
  orderId: string | null; appointmentId: string | null; paymentId: string | null; refundId: string | null;
  buyer: string | null;
  address: Record<string, string> | null;
  lines: DocumentLine[];
  subtotal: number; discount: number; shipping: number; tax: number; total: number;
  /** The COD fee line (absent = 0). */
  codFee?: number;
  /** A business buyer (tax invoice, or the credit note of one): GSTIN, legal name and the GST state of supply. */
  buyerTax?: { gstin: string; legalName: string | null; placeOfSupply: string | null };
}

async function insertDocument(tx: TenantTransaction, accountId: string, draft: Draft): Promise<string> {
  const s = await seller(tx, accountId);
  const now = new Date();
  const fy = financialYear(now, s.timezone || 'UTC');
  const seq = await nextNumber(tx, accountId, fy);
  const number = documentNumber(s.document_prefix || 'RCPT', fy, seq);
  const split = draft.buyerTax ? taxInvoiceSplit(draft.tax, s.state_code, draft.buyerTax.placeOfSupply) : gstSplit(draft.tax, s.state_code, draft.address);
  const sellerJson = { legal_name: s.legal_name || s.account_name.slice(0, 200), gstin: s.gstin, address: s.address, state_code: s.state_code };
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO commerce_documents(account_id, order_id, appointment_id, payment_id, refund_id, kind, number, fy, currency,
      seller, buyer, address, line_items, subtotal_minor, discount_minor, shipping_minor, tax_minor, cgst_minor, sgst_minor,
      igst_minor, total_minor, issued_at, cod_fee_minor)
    VALUES(${accountId}::uuid, ${draft.orderId}::uuid, ${draft.appointmentId}::uuid, ${draft.paymentId}::uuid,
      ${draft.refundId}::uuid, ${draft.kind}, ${number}, ${fy}, ${draft.currency}, ${JSON.stringify(sellerJson)}::jsonb,
      ${JSON.stringify(draft.buyerTax
        ? { name: draft.buyer, gstin: draft.buyerTax.gstin, legal_name: draft.buyerTax.legalName, place_of_supply: draft.buyerTax.placeOfSupply }
        : { name: draft.buyer })}::jsonb, ${draft.address ? JSON.stringify(draft.address) : null}::jsonb,
      ${JSON.stringify(draft.lines)}::jsonb, ${draft.subtotal}, ${draft.discount}, ${draft.shipping}, ${draft.tax},
      ${split.cgst_minor}, ${split.sgst_minor}, ${split.igst_minor}, ${draft.total}, ${now}, ${draft.codFee ?? 0})
    RETURNING id::text AS id`;
  if (draft.orderId) {
    await tx.$executeRaw`INSERT INTO order_events(account_id, order_id, kind, actor, detail)
      VALUES(${accountId}::uuid, ${draft.orderId}::uuid, 'document_issued', 'system', ${draft.kind})`;
  }
  return row.id;
}

interface PaymentRow {
  id: string; order_id: string | null; appointment_id: string | null; amount_minor: bigint; currency: string;
  status: string; settlement: string;
}

async function lockPayment(tx: TenantTransaction, accountId: string, paymentId: string): Promise<PaymentRow | null> {
  const [row] = await tx.$queryRaw<PaymentRow[]>`
    SELECT id::text AS id, order_id::text AS order_id, appointment_id::text AS appointment_id, amount_minor, currency, status, settlement
    FROM customer_payments WHERE account_id=${accountId}::uuid AND id=${paymentId}::uuid FOR UPDATE`;
  return row ?? null;
}

/**
 * Issue (or return the existing) receipt for a settled payment. Returns the
 * document id. Throws DocumentError('not_applicable') for a payment that is
 * not a settled capture of an order or appointment (an exception, an
 * unattached link payment).
 */
export async function issueReceiptTx(tx: TenantTransaction, accountId: string, paymentId: string): Promise<string> {
  // The payment row lock serialises two issuers of the same receipt.
  const payment = await lockPayment(tx, accountId, paymentId);
  if (!payment) throw new DocumentError('not_found', 'Payment not found');
  const [existing] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM commerce_documents
    WHERE account_id=${accountId}::uuid AND payment_id=${paymentId}::uuid AND kind='receipt'`;
  if (existing) return existing.id;
  if (payment.order_id) {
    // One tax invoice covers the order: a later payment of it gets no second document.
    const [invoice] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM commerce_documents
      WHERE account_id=${accountId}::uuid AND order_id=${payment.order_id}::uuid AND kind='tax_invoice'`;
    if (invoice) return invoice.id;
  }
  if (payment.status !== 'captured' || payment.settlement !== 'settled') throw new DocumentError('not_applicable');
  const amount = minorFromDb(payment.amount_minor)!;

  if (payment.order_id) {
    const snap = await orderSnapshot(tx, accountId, payment.order_id);
    if (!snap) throw new DocumentError('not_applicable');
    // A business buyer (GSTIN on the order) takes a tax invoice in place of the receipt, when the seller has a GSTIN.
    if (snap.order.buyer_gstin && (await seller(tx, accountId)).gstin) return issueTaxInvoiceTx(tx, accountId, payment.order_id, paymentId);
    return insertDocument(tx, accountId, {
      kind: 'receipt', currency: snap.order.currency, orderId: payment.order_id, appointmentId: null, paymentId, refundId: null,
      buyer: await buyerName(tx, accountId, snap.order.contact_id), address: documentAddress(snap.order.shipping_address),
      lines: snap.lines, subtotal: snap.subtotal_minor, discount: snap.discount_minor, shipping: snap.shipping_minor,
      codFee: snap.cod_fee_minor, tax: snap.tax_minor, total: snap.total_minor,
    });
  }
  if (payment.appointment_id) {
    const [appt] = await tx.$queryRaw<{ service_name: string; contact_id: string | null }[]>`
      SELECT service_name, contact_id::text AS contact_id FROM appointments
      WHERE account_id=${accountId}::uuid AND id=${payment.appointment_id}::uuid`;
    if (!appt) throw new DocumentError('not_applicable');
    // Appointment prices carry no tax snapshot: the receipt prints the amount paid.
    return insertDocument(tx, accountId, {
      kind: 'receipt', currency: payment.currency, orderId: null, appointmentId: payment.appointment_id, paymentId, refundId: null,
      buyer: await buyerName(tx, accountId, appt.contact_id), address: null,
      lines: [{ name: appt.service_name.slice(0, 200), sku: null, hsn_code: null, quantity: 1, unit_price_minor: amount,
        discount_minor: 0, tax_rate_bps: null, tax_minor: 0, line_total_minor: amount }],
      subtotal: amount, discount: 0, shipping: 0, tax: 0, total: amount,
    });
  }
  throw new DocumentError('not_applicable');
}

/**
 * Issue (or return the existing) GST tax invoice of an order (Store Phase 5). One per order: the order row lock
 * and the unique index on (workspace, order) serialise issuers, and a replay returns the same document. The
 * order needs a buyer GSTIN (DocumentError 'buyer_gstin_missing') and the seller a GSTIN ('seller_gstin_missing');
 * an unpriced or cancelled order, or an unpaid prepaid one (when no settled payment is given), is 'not_applicable'. Place of supply is the buyer
 * GSTIN's state; CGST + SGST when it is the seller's state, IGST otherwise. Numbers come from the same
 * gap-free series as receipts and credit notes.
 */
export async function issueTaxInvoiceTx(tx: TenantTransaction, accountId: string, orderId: string, paymentId: string | null = null): Promise<string> {
  const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM orders
    WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid FOR UPDATE`;
  if (!locked) throw new DocumentError('not_found', 'Order not found');
  const [existing] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM commerce_documents
    WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND kind='tax_invoice'`;
  if (existing) return existing.id;
  const snap = await orderSnapshot(tx, accountId, orderId);
  if (!snap) throw new DocumentError('not_found', 'Order not found');
  const gstin = snap.order.buyer_gstin;
  if (!gstin) throw new DocumentError('buyer_gstin_missing');
  const s = await seller(tx, accountId);
  if (!s.gstin) throw new DocumentError('seller_gstin_missing');
  const [state] = await tx.$queryRaw<{ status: string; priced: boolean; paid: boolean; cod: boolean }[]>`
    SELECT status, priced_at IS NOT NULL AS priced, paid_at IS NOT NULL AS paid, payment_method='cod' AS cod FROM orders
    WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid`;
  if (!state.priced || ['cancelled', 'expired'].includes(state.status) || (!paymentId && !(state.paid || state.cod))) throw new DocumentError('not_applicable');
  let payment = paymentId;
  if (!payment) {
    const [latest] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM customer_payments
      WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND status='captured' AND settlement='settled'
      ORDER BY captured_at DESC NULLS LAST, id LIMIT 1`;
    payment = latest?.id ?? null;
  }
  const address = documentAddress(snap.order.shipping_address);
  return insertDocument(tx, accountId, {
    kind: 'tax_invoice', currency: snap.order.currency, orderId, appointmentId: null, paymentId: payment, refundId: null,
    buyer: await buyerName(tx, accountId, snap.order.contact_id), address,
    lines: snap.lines.map((l) => ({ ...l, taxable_minor: lineTaxableMinor(l.line_total_minor, l.tax_minor) })),
    subtotal: snap.subtotal_minor, discount: snap.discount_minor, shipping: snap.shipping_minor,
    codFee: snap.cod_fee_minor, tax: snap.tax_minor, total: snap.total_minor,
    buyerTax: { gstin, legalName: snap.order.buyer_legal_name, placeOfSupply: placeOfSupplyOf(gstin, address) },
  });
}

/**
 * Issue (or return the existing) credit note for a processed refund. Returns
 * the document id. Only a payment that got a receipt takes a credit note: a
 * refund of an exception or unattached payment reverses no invoiced supply
 * (DocumentError 'not_applicable'). The tax share is allocated cumulatively
 * over the order's credit notes (under the order row lock), so they reverse
 * exactly the order's tax once it is refunded in full.
 */
export async function issueCreditNoteTx(tx: TenantTransaction, accountId: string, refundId: string): Promise<string> {
  const [refund] = await tx.$queryRaw<{ id: string; payment_id: string; amount_minor: bigint; currency: string; status: string }[]>`
    SELECT id::text AS id, payment_id::text AS payment_id, amount_minor, currency, status FROM customer_refunds
    WHERE account_id=${accountId}::uuid AND id=${refundId}::uuid`;
  if (!refund) throw new DocumentError('not_found', 'Refund not found');
  const payment = await lockPayment(tx, accountId, refund.payment_id);
  const [existing] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM commerce_documents
    WHERE account_id=${accountId}::uuid AND refund_id=${refundId}::uuid`;
  if (existing) return existing.id;
  if (refund.status !== 'processed' || !payment) throw new DocumentError('not_applicable');
  // The receipt is the invoiced supply this note reverses; without one there is nothing to credit.
  const [receipt] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM commerce_documents
    WHERE account_id=${accountId}::uuid AND (payment_id=${refund.payment_id}::uuid AND kind='receipt'
      OR (order_id=${payment.order_id}::uuid AND kind='tax_invoice')) LIMIT 1`;
  if (!receipt) throw new DocumentError('not_applicable');
  const amount = minorFromDb(refund.amount_minor)!;

  let orderId: string | null = null, buyer: string | null = null, address: Record<string, string> | null = null, tax = 0;
  let buyerTax: Draft['buyerTax'];
  if (payment.order_id) {
    // Serialises the order's credit notes (lock order: payment -> order), so the cumulative tax share is exact.
    await tx.$queryRaw`SELECT 1 FROM orders WHERE account_id=${accountId}::uuid AND id=${payment.order_id}::uuid FOR UPDATE`;
    const snap = await orderSnapshot(tx, accountId, payment.order_id);
    if (snap) {
      orderId = payment.order_id;
      buyer = await buyerName(tx, accountId, snap.order.contact_id);
      address = documentAddress(snap.order.shipping_address);
      const [prior] = await tx.$queryRaw<{ n: bigint | number | null }[]>`SELECT COALESCE(sum(total_minor),0) AS n FROM commerce_documents
        WHERE account_id=${accountId}::uuid AND order_id=${payment.order_id}::uuid AND kind='credit_note'`;
      tax = refundTaxShare(amount, snap.total_minor, snap.tax_minor, minorFromDb(prior?.n) ?? 0);
      // The credit note of a tax invoice names the same business buyer and splits the tax by the same place of supply.
      const [invoice] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM commerce_documents
        WHERE account_id=${accountId}::uuid AND order_id=${payment.order_id}::uuid AND kind='tax_invoice'`;
      if (invoice && snap.order.buyer_gstin) {
        buyerTax = { gstin: snap.order.buyer_gstin, legalName: snap.order.buyer_legal_name, placeOfSupply: placeOfSupplyOf(snap.order.buyer_gstin, address) };
      }
    }
  } else if (payment.appointment_id) {
    const [appt] = await tx.$queryRaw<{ contact_id: string | null }[]>`SELECT contact_id::text AS contact_id FROM appointments
      WHERE account_id=${accountId}::uuid AND id=${payment.appointment_id}::uuid`;
    buyer = await buyerName(tx, accountId, appt?.contact_id ?? null);
  }
  return insertDocument(tx, accountId, {
    kind: 'credit_note', currency: refund.currency, orderId, appointmentId: payment.appointment_id, paymentId: null, refundId,
    buyer, address, buyerTax,
    lines: [{ name: 'Refund', sku: null, hsn_code: null, quantity: 1, unit_price_minor: amount, discount_minor: 0,
      tax_rate_bps: null, tax_minor: tax, line_total_minor: amount }],
    // The refunded amount includes its tax share.
    subtotal: amount - tax, discount: 0, shipping: 0, tax, total: amount,
  });
}

const worker = <T,>(accountId: string, fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, fn, getWorkerPrisma());

/** A payment or refund that does not take a document finishes the job without one. */
async function quietly(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof DocumentError) return;
    throw error;
  }
}

/**
 * Issue (or return the existing) receipt for an order that was paid in full with store credit and loyalty
 * points: the same document as a payment's receipt, with no payment attached. The order row lock serialises
 * two issuers. Throws DocumentError('not_applicable') unless the order is paid, priced and has no settled payment
 * (an order with one gets its receipt from that payment).
 */
export async function issueOrderReceiptTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<string> {
  const [order] = await tx.$queryRaw<{ paid: boolean; settled: number }[]>`
    SELECT (o.paid_at IS NOT NULL AND o.priced_at IS NOT NULL AND o.store_credit_minor + o.points_value_minor >= o.total_minor) AS paid,
      (SELECT count(*)::int FROM customer_payments p WHERE p.account_id=o.account_id AND p.order_id=o.id AND p.settlement='settled') AS settled
    FROM orders o WHERE o.account_id=${accountId}::uuid AND o.id=${orderId}::uuid FOR UPDATE OF o`;
  if (!order) throw new DocumentError('not_found', 'Order not found');
  const [existing] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM commerce_documents
    WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND kind='receipt' AND payment_id IS NULL`;
  if (existing) return existing.id;
  if (!order.paid || order.settled > 0) throw new DocumentError('not_applicable');
  const snap = await orderSnapshot(tx, accountId, orderId);
  if (!snap) throw new DocumentError('not_applicable');
  return insertDocument(tx, accountId, {
    kind: 'receipt', currency: snap.order.currency, orderId, appointmentId: null, paymentId: null, refundId: null,
    buyer: await buyerName(tx, accountId, snap.order.contact_id), address: documentAddress(snap.order.shipping_address),
    lines: snap.lines, subtotal: snap.subtotal_minor, discount: snap.discount_minor, shipping: snap.shipping_minor,
    codFee: snap.cod_fee_minor, tax: snap.tax_minor, total: snap.total_minor,
  });
}

export async function handleIssueReceiptJob(accountId: string, payload: IssueReceiptJobPayload): Promise<void> {
  const { paymentId, orderId } = payload;
  if (paymentId) await quietly(() => worker(accountId, (tx) => issueReceiptTx(tx, accountId, paymentId)));
  else if (orderId) await quietly(() => worker(accountId, (tx) => issueOrderReceiptTx(tx, accountId, orderId)));
  else throw new Error('Invalid issue receipt job contract');
}

export async function handleIssueCreditNoteJob(accountId: string, payload: IssueCreditNoteJobPayload): Promise<void> {
  await quietly(() => worker(accountId, (tx) => issueCreditNoteTx(tx, accountId, payload.refundId)));
}

// ---------------------------------------------------------------------------
// Reading and printing (caller's session, app role; agents and above by RLS)

interface DocumentDbRow {
  id: string; kind: DocumentKind; number: string; fy: string; currency: string; order_id: string | null;
  appointment_id: string | null; payment_id: string | null; refund_id: string | null; seller: unknown; buyer: unknown;
  address: unknown; line_items: unknown; subtotal_minor: bigint; discount_minor: bigint; shipping_minor: bigint;
  tax_minor: bigint; cgst_minor: bigint; sgst_minor: bigint; igst_minor: bigint; total_minor: bigint;
  tax_inclusive: boolean | null; issued_at: Date; cod_fee_minor: bigint;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : null);

function toDocument(row: DocumentDbRow): CommerceDocument {
  const s = obj(row.seller);
  const address = obj(row.address);
  return {
    id: row.id, kind: row.kind, number: row.number, fy: row.fy, currency: row.currency, order_id: row.order_id,
    appointment_id: row.appointment_id, payment_id: row.payment_id, refund_id: row.refund_id,
    seller: { legal_name: str(s.legal_name), gstin: str(s.gstin), address: str(s.address), state_code: str(s.state_code) },
    buyer: { name: str(obj(row.buyer).name), gstin: str(obj(row.buyer).gstin), legal_name: str(obj(row.buyer).legal_name),
      place_of_supply: str(obj(row.buyer).place_of_supply) },
    address: row.address ? Object.fromEntries(Object.entries(address).filter(([, v]) => typeof v === 'string')) as Record<string, string> : null,
    line_items: Array.isArray(row.line_items) ? (row.line_items as DocumentLine[]) : [],
    subtotal_minor: minorFromDb(row.subtotal_minor)!, discount_minor: minorFromDb(row.discount_minor)!,
    shipping_minor: minorFromDb(row.shipping_minor)!, cod_fee_minor: minorFromDb(row.cod_fee_minor) ?? 0, tax_minor: minorFromDb(row.tax_minor)!,
    cgst_minor: minorFromDb(row.cgst_minor)!, sgst_minor: minorFromDb(row.sgst_minor)!, igst_minor: minorFromDb(row.igst_minor)!,
    total_minor: minorFromDb(row.total_minor)!, tax_inclusive: row.tax_inclusive, issued_at: row.issued_at.toISOString(),
  };
}

export async function getCommerceDocument(ctx: TenantContext, id: string): Promise<CommerceDocument | null> {
  if (!UUID.test(id)) return null;
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.$queryRaw<DocumentDbRow[]>`
      SELECT d.id::text AS id, d.kind, d.number, d.fy, d.currency, d.order_id::text AS order_id,
        d.appointment_id::text AS appointment_id, d.payment_id::text AS payment_id, d.refund_id::text AS refund_id,
        d.seller, d.buyer, d.address, d.line_items, d.subtotal_minor, d.discount_minor, d.shipping_minor, d.tax_minor,
        d.cgst_minor, d.sgst_minor, d.igst_minor, d.total_minor, o.tax_inclusive, d.issued_at, d.cod_fee_minor
      FROM commerce_documents d LEFT JOIN orders o ON o.account_id=d.account_id AND o.id=d.order_id
      WHERE d.account_id=${ctx.accountId}::uuid AND d.id=${id}::uuid`;
    return row ? toDocument(row) : null;
  });
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface DocumentLabels {
  receipt: string; taxInvoice: string; creditNote: string; number: string; date: string; seller: string; gstin: string;
  billTo: string; shipTo: string; item: string; hsn: string; qty: string; price: string; discount: string; tax: string;
  amount: string; subtotal: string; shipping: string; cgst: string; sgst: string; igst: string; total: string;
  taxIncluded: string; codFee: string;
  placeOfSupply: string; taxable: string; rate: string;
}

/**
 * Printable HTML (served with CSP default-src 'none'; inline styles only).
 * Every value is escaped; amounts are formatted from integer minor units.
 */
export function renderCommerceDocumentHtml(doc: CommerceDocument, labels: DocumentLabels, locale = 'en'): string {
  const m = (minor: number) => escapeHtml(formatMoney(minor, doc.currency, { locale }));
  const business = doc.buyer.gstin !== null;
  const invoice = doc.kind === 'tax_invoice';
  const title = doc.kind === 'credit_note' ? labels.creditNote : invoice || doc.seller.gstin ? labels.taxInvoice : labels.receipt;
  const issued = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(doc.issued_at));
  const addressLines = doc.address
    ? ['name', 'line1', 'line2', 'city', 'state', 'postal_code', 'country'].map((k) => doc.address![k]).filter(Boolean)
    : [];
  const rows = doc.line_items.map((l) => `<tr><td>${escapeHtml(l.name)}${l.sku ? `<div class="muted">${escapeHtml(l.sku)}</div>` : ''}</td>
<td>${escapeHtml(l.hsn_code ?? '')}</td><td class="num">${escapeHtml(l.quantity)}</td><td class="num">${m(l.unit_price_minor)}</td>
<td class="num">${l.discount_minor ? m(l.discount_minor) : ''}</td>${invoice ? `<td class="num">${m(l.taxable_minor ?? l.line_total_minor - l.tax_minor)}</td><td class="num">${l.tax_rate_bps === null ? '' : `${l.tax_rate_bps / 100}%`}</td>` : ''}<td class="num">${l.tax_minor ? m(l.tax_minor) : ''}</td>
<td class="num">${m(l.line_total_minor)}</td></tr>`).join('\n');
  const total = (label: string, minor: number, strong = false) =>
    `<tr${strong ? ' class="strong"' : ''}><td>${escapeHtml(label)}</td><td class="num">${m(minor)}</td></tr>`;
  const totals = [
    total(labels.subtotal, doc.subtotal_minor),
    doc.discount_minor ? total(labels.discount, doc.discount_minor) : '',
    doc.shipping_minor ? total(labels.shipping, doc.shipping_minor) : '',
    doc.cod_fee_minor ? total(labels.codFee, doc.cod_fee_minor) : '',
    doc.cgst_minor ? total(labels.cgst, doc.cgst_minor) : '',
    doc.sgst_minor ? total(labels.sgst, doc.sgst_minor) : '',
    doc.igst_minor ? total(labels.igst, doc.igst_minor) : '',
    doc.tax_minor && !doc.cgst_minor && !doc.sgst_minor && !doc.igst_minor ? total(labels.tax, doc.tax_minor) : '',
    total(labels.total, doc.total_minor, true),
  ].join('');
  return `<!doctype html><html lang="${escapeHtml(locale)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)} ${escapeHtml(doc.number)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;color:#111;background:#fff;margin:0;padding:24px}main{max-width:800px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}.muted{color:#555;font-size:12px}.cols{display:flex;flex-wrap:wrap;gap:24px;margin:20px 0}
.cols>div{flex:1 1 220px}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}
.num{text-align:right;white-space:nowrap}.totals{max-width:320px;margin-left:auto}.strong td{font-weight:600;border-top:2px solid #111}
@media print{body{padding:0}}</style></head><body><main>
<h1>${escapeHtml(title)}</h1><div class="muted">${escapeHtml(labels.number)}: ${escapeHtml(doc.number)} · ${escapeHtml(labels.date)}: ${escapeHtml(issued)}</div>
<div class="cols"><div><strong>${escapeHtml(labels.seller)}</strong><div>${escapeHtml(doc.seller.legal_name ?? '')}</div>
<div>${escapeHtml(doc.seller.address ?? '')}</div>${doc.seller.gstin ? `<div>${escapeHtml(labels.gstin)}: ${escapeHtml(doc.seller.gstin)}</div>` : ''}</div>
<div><strong>${escapeHtml(labels.billTo)}</strong>${doc.buyer.legal_name ? `<div>${escapeHtml(doc.buyer.legal_name)}</div>` : ''}<div>${escapeHtml(doc.buyer.name ?? '')}</div>
${business ? `<div>${escapeHtml(labels.gstin)}: ${escapeHtml(doc.buyer.gstin)}</div>` : ''}${doc.buyer.place_of_supply ? `<div>${escapeHtml(labels.placeOfSupply)}: ${escapeHtml(doc.buyer.place_of_supply)}</div>` : ''}</div>
${addressLines.length ? `<div><strong>${escapeHtml(labels.shipTo)}</strong>${addressLines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</div>` : ''}</div>
<table><thead><tr><th>${escapeHtml(labels.item)}</th><th>${escapeHtml(labels.hsn)}</th><th class="num">${escapeHtml(labels.qty)}</th>
<th class="num">${escapeHtml(labels.price)}</th><th class="num">${escapeHtml(labels.discount)}</th>${invoice ? `<th class="num">${escapeHtml(labels.taxable)}</th><th class="num">${escapeHtml(labels.rate)}</th>` : ''}<th class="num">${escapeHtml(labels.tax)}</th>
<th class="num">${escapeHtml(labels.amount)}</th></tr></thead><tbody>${rows}</tbody></table>
<table class="totals"><tbody>${totals}</tbody></table>
${doc.tax_inclusive ? `<p class="muted">${escapeHtml(labels.taxIncluded)}</p>` : ''}
</main></body></html>`;
}
