// Indian GST for platform invoices (SaaS, SAC 998314) at 18%.
//
// Place of supply is the buyer's state: the state of their GSTIN when they have
// one, otherwise the state of their billing address.
//   - Buyer in the seller's state (intra-state): CGST 9% + SGST 9%.
//   - Buyer in another Indian state (inter-state): IGST 18%.
//   - Buyer outside India: export of services, zero-rated (supplied under LUT), no tax.
//
// Rounding: amounts are integer paise. Each tax line is rounded on its own to
// the nearest paisa, halves away from zero (0.5 paise -> 1 paisa). CGST and SGST
// are each 9% of the taxable amount, so CGST + SGST may differ from an 18% IGST
// on the same amount by one paisa; the invoice total is always the sum of the
// rounded lines (invoices CHECK total = subtotal + taxes).

export const GST_RATE_BPS = 1800;
const HALF_RATE_BPS = GST_RATE_BPS / 2;
/** Largest taxable amount accepted (₹10 crore in paise), far above any plan. */
const MAX_AMOUNT_MINOR = 10_000_000_000;

export type GstKind = 'intra_state' | 'inter_state' | 'export';

export interface GstBreakdown {
  kind: GstKind;
  cgst: number;
  sgst: number;
  igst: number;
  /** Sum of the three, in paise. */
  tax: number;
  /** GST state code of the place of supply, or null for an export. */
  placeOfSupply: string | null;
}

export interface ComputeGstInput {
  /** Taxable value in paise (before GST). */
  amountMinor: number;
  /** The platform's registered state; normally sellerStateCode(). */
  sellerStateCode: string;
  /** Required for an Indian buyer: their GSTIN state, else their billing-address state. */
  buyerStateCode?: string | null;
  /** ISO 3166-1 alpha-2; anything other than 'IN' is an export. */
  buyerCountry: string;
}

export class GstError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GstError';
  }
}

/** GST state codes: 01-38 (states and union territories), 97 other territory, 99 centre jurisdiction. */
export function isGstStateCode(code: unknown): code is string {
  if (typeof code !== 'string' || !/^[0-9]{2}$/.test(code)) return false;
  const n = Number(code);
  return (n >= 1 && n <= 38) || n === 97 || n === 99;
}

/** The platform's GST state from BILLING_SELLER_STATE_CODE, or null when unset or invalid. */
export function sellerStateCode(env: Record<string, string | undefined> = process.env): string | null {
  const code = env.BILLING_SELLER_STATE_CODE?.trim();
  return isGstStateCode(code) ? code : null;
}

function percentOf(amountMinor: number, bps: number): number {
  // Integer maths: round(amount * bps / 10000), halves up (amounts are never negative).
  return Number((BigInt(amountMinor) * BigInt(bps) * BigInt(2) + BigInt(10_000)) / BigInt(20_000));
}

export function computeGst(input: ComputeGstInput): GstBreakdown {
  const { amountMinor } = input;
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || amountMinor > MAX_AMOUNT_MINOR) throw new GstError('Invalid taxable amount');
  if (!isGstStateCode(input.sellerStateCode)) throw new GstError('Invalid seller state code');
  const country = (input.buyerCountry ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new GstError('Invalid buyer country');
  if (country !== 'IN') return { kind: 'export', cgst: 0, sgst: 0, igst: 0, tax: 0, placeOfSupply: null };
  const buyer = input.buyerStateCode ?? null;
  if (!isGstStateCode(buyer)) throw new GstError('An Indian buyer needs a GST state code');
  if (buyer === input.sellerStateCode) {
    const half = percentOf(amountMinor, HALF_RATE_BPS);
    return { kind: 'intra_state', cgst: half, sgst: half, igst: 0, tax: half * 2, placeOfSupply: buyer };
  }
  const igst = percentOf(amountMinor, GST_RATE_BPS);
  return { kind: 'inter_state', cgst: 0, sgst: 0, igst, tax: igst, placeOfSupply: buyer };
}

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** The GSTIN check character for its first 14 characters (GSTN's mod-36 scheme). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

/**
 * Normalises (trim, upper-case) and validates a GSTIN: format, state code and
 * check character. Returns the normalised GSTIN or null when invalid.
 */
export function validateGstin(gstin: unknown): string | null {
  if (typeof gstin !== 'string') return null;
  const value = gstin.trim().toUpperCase();
  if (!GSTIN_FORMAT.test(value) || !isGstStateCode(value.slice(0, 2))) return null;
  return gstinCheckChar(value.slice(0, 14)) === value[14] ? value : null;
}
