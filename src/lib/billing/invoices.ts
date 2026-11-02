// GST tax invoices for platform subscription charges. Server only.
//
// One invoice per successful charge, issued from the verified provider event
// in the worker transaction that applies it: the number comes from the gapless
// per-financial-year sequence in the same transaction, so a rollback releases
// it, and a replayed event finds the existing invoice (provider invoice id or
// payment id) instead of issuing a second one.
//
// Amounts: the charged amount is the invoice total. It is split into the
// taxable value and GST (CGST+SGST in the seller's state, IGST elsewhere in
// India, nothing for an export), so the tax invoice always matches what the
// customer paid. Razorpay plan amounts must therefore include GST for Indian
// customers (see the deployment runbook). Add-on packs are priced excluding GST
// and charged with the buyer's GST added (addons.ts), so they too reach the
// invoice GST-inclusive.
//
// There is no PDF library in the app: an invoice is rendered as a printable
// HTML page (renderInvoiceHtml) that the browser saves as PDF. No PDF is stored.

import type { TenantTransaction } from '@/lib/db/tenant';
import { computeGst, GST_RATE_BPS, sellerStateCode, type GstBreakdown } from './gst';
import { nextInvoiceNumber } from './invoice-number';
import type { BillingInterval } from './provider';

/** SAC for online information / SaaS services. */
export const SAC_CODE = '998314';

export interface BuyerAddress {
  legalName: string;
  gstin: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  stateCode: string | null;
  postalCode: string;
  country: string;
  email: string;
}

export interface InvoiceSplit {
  subtotal: number;
  gst: GstBreakdown;
}

/**
 * Splits a GST-inclusive total into taxable value + tax so that
 * subtotal + cgst + sgst + igst === total exactly. Each tax line is rounded on
 * its own (gst.ts); when no taxable value reproduces the total, the paisa of
 * rounding difference stays in the taxable value.
 */
export function splitInclusiveTotal(totalMinor: number, sellerState: string, buyer: { stateCode: string | null; country: string }): InvoiceSplit {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) throw new Error('Invalid invoice total');
  const gstFor = (amountMinor: number) => computeGst({ amountMinor, sellerStateCode: sellerState, buyerStateCode: buyer.stateCode, buyerCountry: buyer.country });
  const base = Math.floor((totalMinor * 10_000) / (10_000 + GST_RATE_BPS));
  for (const candidate of [base, base + 1, base - 1, base + 2, base - 2]) {
    if (candidate < 0) continue;
    const gst = gstFor(candidate);
    if (candidate + gst.tax === totalMinor) return { subtotal: candidate, gst };
  }
  const gst = gstFor(base);
  return { subtotal: totalMinor - gst.tax, gst };
}

/** The buyer's place of supply, by the same rule issueInvoice uses (GSTIN state, else address state; no profile: the seller's state). */
export async function invoiceBuyer(tx: TenantTransaction, accountId: string, seller: string): Promise<{ stateCode: string | null; country: string }> {
  const [p] = await tx.$queryRaw<{ gstin: string | null; state_code: string | null; country: string }[]>`
    SELECT gstin, state_code, country FROM billing_profiles WHERE account_id=${accountId}::uuid`;
  return p ? { stateCode: p.gstin ? p.gstin.slice(0, 2) : p.state_code, country: p.country } : { stateCode: seller, country: 'IN' };
}

export interface IssueInvoiceInput {
  accountId: string;
  provider: 'razorpay';
  providerInvoiceId: string | null;
  providerPaymentId: string | null;
  /** The charged amount, GST included, in paise. */
  amountMinor: number;
  currency: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  planName: string;
  interval: BillingInterval | null;
  /** Issue date (tests pin it). */
  now?: Date;
}

export class InvoiceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceConfigError';
  }
}

/**
 * Issues (or finds) the invoice for one charge. Call inside the worker-role
 * tenant transaction that applies the provider event. Returns created: false
 * when this charge already has an invoice.
 */
export async function issueInvoice(tx: TenantTransaction, input: IssueInvoiceInput): Promise<{ id: string; number: string; created: boolean }> {
  if (!input.providerInvoiceId && !input.providerPaymentId) throw new Error('A charge needs a provider invoice or payment id');
  if (input.currency !== 'INR') throw new InvoiceConfigError('Only INR charges are invoiced');
  const existing = await tx.$queryRaw<{ id: string; number: string }[]>`
    SELECT id, number FROM invoices WHERE account_id=${input.accountId}::uuid AND provider=${input.provider}
      AND ((${input.providerInvoiceId}::text IS NOT NULL AND provider_invoice_id=${input.providerInvoiceId})
        OR (${input.providerPaymentId}::text IS NOT NULL AND provider_payment_id=${input.providerPaymentId}))
    LIMIT 1`;
  if (existing[0]) return { ...existing[0], created: false };

  const seller = sellerStateCode();
  if (!seller) throw new InvoiceConfigError('BILLING_SELLER_STATE_CODE is not set');
  const profiles = await tx.$queryRaw<{ legal_name: string; gstin: string | null; address_line1: string; address_line2: string | null; city: string;
    state_code: string | null; postal_code: string; country: string; email: string }[]>`
    SELECT legal_name, gstin, address_line1, address_line2, city, state_code, postal_code, country, email
    FROM billing_profiles WHERE account_id=${input.accountId}::uuid`;
  const p = profiles[0];
  // Without a profile the place of supply is the supplier's location (unregistered buyer, address unknown).
  const buyer = p ? { stateCode: p.gstin ? p.gstin.slice(0, 2) : p.state_code, country: p.country } : { stateCode: seller, country: 'IN' };
  const { subtotal, gst } = splitInclusiveTotal(input.amountMinor, seller, buyer);
  const now = input.now ?? new Date();
  const number = await nextInvoiceNumber(tx, now);
  const address = p ? { legal_name: p.legal_name, address_line1: p.address_line1, address_line2: p.address_line2, city: p.city,
    state_code: p.state_code, postal_code: p.postal_code, country: p.country, email: p.email } : {};
  const lines = [{
    description: `${input.planName} plan${input.interval ? ` (${input.interval === 'year' ? 'yearly' : 'monthly'})` : ''}`,
    sac: SAC_CODE,
    quantity: 1,
    amount_minor: subtotal,
  }];
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO invoices (account_id, number, provider, provider_invoice_id, provider_payment_id, period_start, period_end, currency,
      subtotal_minor, cgst_minor, sgst_minor, igst_minor, total_minor, place_of_supply_state_code, gstin_snapshot,
      billing_address_snapshot, line_items, status, issued_at, paid_at)
    VALUES (${input.accountId}::uuid, ${number}, ${input.provider}, ${input.providerInvoiceId}, ${input.providerPaymentId},
      ${input.periodStart}, ${input.periodEnd}, 'INR', ${subtotal}, ${gst.cgst}, ${gst.sgst}, ${gst.igst}, ${input.amountMinor},
      ${gst.placeOfSupply}, ${p?.gstin ?? null}, ${JSON.stringify(address)}::jsonb, ${JSON.stringify(lines)}::jsonb, 'paid', ${now}, ${now})
    RETURNING id`;
  return { id: rows[0].id, number, created: true };
}

export interface InvoiceSummary {
  id: string;
  number: string;
  issuedAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string;
  totalMinor: number;
  status: 'issued' | 'paid' | 'void';
}

export interface InvoiceDetail extends InvoiceSummary {
  subtotalMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  placeOfSupply: string | null;
  gstin: string | null;
  billTo: Partial<Record<'legal_name' | 'address_line1' | 'address_line2' | 'city' | 'state_code' | 'postal_code' | 'country' | 'email', string | null>>;
  lines: { description: string; sac: string; quantity: number; amount_minor: number }[];
  paidAt: string | null;
}

type InvoiceDbRow = {
  id: string; number: string; issued_at: Date; period_start: Date | null; period_end: Date | null; currency: string;
  total_minor: bigint; status: InvoiceSummary['status'];
};
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const summary = (r: InvoiceDbRow): InvoiceSummary => ({
  id: r.id, number: r.number, issuedAt: r.issued_at.toISOString(), periodStart: iso(r.period_start), periodEnd: iso(r.period_end),
  currency: r.currency, totalMinor: Number(r.total_minor), status: r.status,
});

/** The workspace's invoices, newest first (no provider ids). */
export async function listInvoices(tx: TenantTransaction, accountId: string, limit = 100): Promise<InvoiceSummary[]> {
  const rows = await tx.$queryRaw<InvoiceDbRow[]>`
    SELECT id, number, issued_at, period_start, period_end, currency, total_minor, status FROM invoices
    WHERE account_id=${accountId}::uuid ORDER BY issued_at DESC, number DESC LIMIT ${Math.min(Math.max(1, limit), 500)}`;
  return rows.map(summary);
}

export async function getInvoice(tx: TenantTransaction, accountId: string, id: string): Promise<InvoiceDetail | null> {
  const rows = await tx.$queryRaw<(InvoiceDbRow & { subtotal_minor: bigint; cgst_minor: bigint; sgst_minor: bigint; igst_minor: bigint;
    place_of_supply_state_code: string | null; gstin_snapshot: string | null; billing_address_snapshot: InvoiceDetail['billTo'];
    line_items: InvoiceDetail['lines']; paid_at: Date | null })[]>`
    SELECT id, number, issued_at, period_start, period_end, currency, total_minor, status, subtotal_minor, cgst_minor, sgst_minor, igst_minor,
      place_of_supply_state_code, gstin_snapshot, billing_address_snapshot, line_items, paid_at
    FROM invoices WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
  const r = rows[0];
  if (!r) return null;
  return {
    ...summary(r),
    subtotalMinor: Number(r.subtotal_minor), cgstMinor: Number(r.cgst_minor), sgstMinor: Number(r.sgst_minor), igstMinor: Number(r.igst_minor),
    placeOfSupply: r.place_of_supply_state_code, gstin: r.gstin_snapshot,
    billTo: r.billing_address_snapshot ?? {}, lines: Array.isArray(r.line_items) ? r.line_items : [], paidAt: iso(r.paid_at),
  };
}

export interface SellerDetails {
  name: string;
  gstin: string | null;
  address: string;
  stateCode: string | null;
}

/** The platform's invoice header from env: BILLING_SELLER_NAME, BILLING_SELLER_GSTIN, BILLING_SELLER_ADDRESS, BILLING_SELLER_STATE_CODE. */
export function sellerDetails(env: Record<string, string | undefined> = process.env): SellerDetails {
  return {
    name: env.BILLING_SELLER_NAME?.trim() || 'Bodhinox',
    gstin: env.BILLING_SELLER_GSTIN?.trim() || null,
    address: env.BILLING_SELLER_ADDRESS?.trim() || '',
    stateCode: sellerStateCode(env),
  };
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Paise as rupees with two decimals, Indian grouping. */
export function formatMinor(minor: number, currency = 'INR'): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const rupees = Math.floor(abs / 100).toLocaleString('en-IN');
  return `${currency === 'INR' ? '₹' : `${currency} `}${sign}${rupees}.${String(abs % 100).padStart(2, '0')}`;
}

const day = (value: string | null) => (value ? new Date(value).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '');

/**
 * A self-contained printable tax invoice (no scripts, no external assets).
 * Every value is escaped. Labels are English, as GST invoices are issued.
 */
export function renderInvoiceHtml(invoice: InvoiceDetail, seller: SellerDetails): string {
  const b = invoice.billTo;
  const taxRows = [
    invoice.cgstMinor ? ['CGST @ 9%', invoice.cgstMinor] : null,
    invoice.sgstMinor ? ['SGST @ 9%', invoice.sgstMinor] : null,
    invoice.igstMinor ? ['IGST @ 18%', invoice.igstMinor] : null,
  ].filter((x): x is [string, number] => x !== null);
  const exportNote = !invoice.cgstMinor && !invoice.sgstMinor && !invoice.igstMinor && b.country && b.country !== 'IN'
    ? '<p class="note">Export of services under LUT without payment of IGST.</p>' : '';
  const money = (n: number) => escapeHtml(formatMinor(n, invoice.currency));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tax invoice ${escapeHtml(invoice.number)}</title>
<style>
body{font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:0;background:#fff}
main{max-width:780px;margin:32px auto;padding:0 24px}
h1{font-size:22px;margin:0 0 4px}
.muted{color:#555}.row{display:flex;gap:24px;justify-content:space-between;flex-wrap:wrap;margin:24px 0}
table{width:100%;border-collapse:collapse;margin-top:16px}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd}
td.n,th.n{text-align:right}tfoot td{font-weight:600}.note{font-size:12px;color:#555}
@media print{main{margin:0}.noprint{display:none}}
</style></head>
<body><main>
<h1>Tax invoice</h1>
<div class="muted">No. ${escapeHtml(invoice.number)} · Date ${escapeHtml(day(invoice.issuedAt))}</div>
<div class="row">
<section><strong>${escapeHtml(seller.name)}</strong><br>${escapeHtml(seller.address).replace(/\n/g, '<br>')}
${seller.gstin ? `<br>GSTIN ${escapeHtml(seller.gstin)}` : ''}</section>
<section><strong>Bill to</strong><br>${escapeHtml(b.legal_name)}<br>${escapeHtml(b.address_line1)}${b.address_line2 ? `<br>${escapeHtml(b.address_line2)}` : ''}
<br>${escapeHtml(b.city)} ${escapeHtml(b.postal_code)}<br>${escapeHtml(b.country)}${invoice.gstin ? `<br>GSTIN ${escapeHtml(invoice.gstin)}` : ''}</section>
</div>
<div class="muted">Place of supply: ${invoice.placeOfSupply ? `state code ${escapeHtml(invoice.placeOfSupply)}` : 'outside India'}
${invoice.periodStart ? ` · Service period ${escapeHtml(day(invoice.periodStart))} – ${escapeHtml(day(invoice.periodEnd))}` : ''}</div>
<table><thead><tr><th>Description</th><th>SAC</th><th class="n">Qty</th><th class="n">Amount</th></tr></thead>
<tbody>${invoice.lines.map((l) => `<tr><td>${escapeHtml(l.description)}</td><td>${escapeHtml(l.sac)}</td><td class="n">${escapeHtml(l.quantity)}</td><td class="n">${money(Number(l.amount_minor) || 0)}</td></tr>`).join('')}</tbody>
<tfoot><tr><td colspan="3">Taxable value</td><td class="n">${money(invoice.subtotalMinor)}</td></tr>
${taxRows.map(([label, amount]) => `<tr><td colspan="3">${escapeHtml(label)}</td><td class="n">${money(amount)}</td></tr>`).join('')}
<tr><td colspan="3">Total</td><td class="n">${money(invoice.totalMinor)}</td></tr></tfoot></table>
${exportNote}
<p class="note">Status: ${escapeHtml(invoice.status)}${invoice.paidAt ? ` · Paid ${escapeHtml(day(invoice.paidAt))}` : ''}. This is a computer-generated invoice.</p>
<p class="note noprint">Use your browser's Print command to save this invoice as a PDF.</p>
</main></body></html>`;
}
