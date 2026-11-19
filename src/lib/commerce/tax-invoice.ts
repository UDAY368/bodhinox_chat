/**
 * GST tax invoice rules that need no database (Store Phase 5): the buyer's
 * GSTIN and legal name, GST state codes (a seller or address may hold the
 * two-digit GST code or the two-letter state code), the place of supply, and
 * the per-line taxable value. The issuing itself lives in documents.ts.
 */
import { isGstStateCode, validateGstin } from '@/lib/billing/gst';

/** GST numeric state code to the two-letter state code used on addresses. */
const GST_TO_ALPHA: Record<string, string> = {
  '01': 'JK', '02': 'HP', '03': 'PB', '04': 'CH', '05': 'UT', '06': 'HR', '07': 'DL', '08': 'RJ', '09': 'UP', '10': 'BR',
  '11': 'SK', '12': 'AR', '13': 'NL', '14': 'MN', '15': 'MZ', '16': 'TR', '17': 'ML', '18': 'AS', '19': 'WB', '20': 'JH',
  '21': 'OD', '22': 'CG', '23': 'MP', '24': 'GJ', '25': 'DD', '26': 'DN', '27': 'MH', '28': 'AP', '29': 'KA', '30': 'GA',
  '31': 'LD', '32': 'KL', '33': 'TN', '34': 'PY', '35': 'AN', '36': 'TS', '37': 'AP', '38': 'LA',
};
const ALPHA_TO_GST: Record<string, string> = {};
for (const [gst, alpha] of Object.entries(GST_TO_ALPHA)) ALPHA_TO_GST[alpha] ??= gst;
// Odisha was often written OR; Telangana 36 and Andhra Pradesh 37 are both in use.
ALPHA_TO_GST.OR = '21';

/** The two-digit GST state code for a GST code or a two-letter state code; null when unknown. */
export function toGstStateCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toUpperCase();
  if (isGstStateCode(v)) return v;
  return ALPHA_TO_GST[v] ?? null;
}

/** Place of supply: the buyer GSTIN's state, else the shipping address state; null when neither is known. */
export function placeOfSupply(buyerGstin: string | null, address: { state_code?: unknown } | null): string | null {
  if (buyerGstin) return toGstStateCode(buyerGstin.slice(0, 2));
  return toGstStateCode(address?.state_code);
}

export interface BuyerTaxIdentity { gstin: string | null; legal_name: string | null }

/**
 * Parse the buyer fields a browser sends. An empty or absent GSTIN means
 * "no business buyer" (and drops the legal name). Returns null for a GSTIN
 * that is not valid (format, state code, check character) or a name that is
 * too long, so the caller can refuse it.
 */
export function parseBuyerTaxIdentity(gstin: unknown, legalName: unknown): BuyerTaxIdentity | null {
  const rawGstin = gstin === undefined || gstin === null ? '' : gstin;
  const rawName = legalName === undefined || legalName === null ? '' : legalName;
  if (typeof rawGstin !== 'string' || typeof rawName !== 'string') return null;
  if (!rawGstin.trim()) return rawName.trim() ? null : { gstin: null, legal_name: null };
  const valid = validateGstin(rawGstin);
  if (!valid) return null;
  const name = rawName.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (name.length > 200) return null;
  return { gstin: valid, legal_name: name || null };
}

/** The taxable value of a priced line: its total less its tax (both inclusive and exclusive pricing). */
export function lineTaxableMinor(lineTotalMinor: number, taxMinor: number): number {
  return Math.max(0, lineTotalMinor - Math.max(0, taxMinor));
}

/**
 * CGST + SGST when the seller's state is the place of supply (sgst = floor(tax / 2), cgst = the rest, so they sum
 * exactly), IGST otherwise; no split when either state is unknown.
 */
export function taxInvoiceSplit(taxMinor: number, sellerState: unknown, supplyState: string | null) {
  const seller = toGstStateCode(sellerState);
  const zero = { cgst_minor: 0, sgst_minor: 0, igst_minor: 0 };
  if (taxMinor <= 0 || !seller || !supplyState) return zero;
  if (seller !== supplyState) return { ...zero, igst_minor: taxMinor };
  const sgst = Math.floor(taxMinor / 2);
  return { cgst_minor: taxMinor - sgst, sgst_minor: sgst, igst_minor: 0 };
}
