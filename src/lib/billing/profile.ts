// The workspace's GST billing profile (billing_profiles): who invoices are
// addressed to. Admins read and write it through the app role.

import type { TenantTransaction } from '@/lib/db/tenant';
import { isGstStateCode, validateGstin } from './gst';

export interface BillingProfile {
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

export type ProfileErrorCode = 'invalid_profile' | 'invalid_gstin' | 'gstin_state_mismatch' | 'state_required' | 'gstin_outside_india';

export class ProfileInputError extends Error {
  constructor(public readonly code: ProfileErrorCode) {
    super(code);
    this.name = 'ProfileInputError';
  }
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);
const optional = (v: unknown, max: number): string | null | undefined =>
  v === undefined || v === null || (typeof v === 'string' && !v.trim()) ? null : text(v, max) ?? undefined;
const EMAIL = /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,185}\.[^\s@<>",;]{2,}$/;

/** Validates a PUT body. A GSTIN must pass its checksum, and its first two digits are the state. */
export function parseBillingProfile(raw: unknown): BillingProfile {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const legalName = text(r.legal_name, 200), addressLine1 = text(r.address_line1, 200), city = text(r.city, 100);
  const postalCode = text(r.postal_code, 20), email = text(r.email, 254);
  const addressLine2 = optional(r.address_line2, 200);
  const country = (text(r.country ?? 'IN', 2) ?? '').toUpperCase();
  if (!legalName || !addressLine1 || !city || !postalCode || !email || !EMAIL.test(email) || addressLine2 === undefined || !/^[A-Z]{2}$/.test(country))
    throw new ProfileInputError('invalid_profile');
  const rawGstin = optional(r.gstin, 20);
  if (rawGstin === undefined) throw new ProfileInputError('invalid_gstin');
  const gstin = rawGstin ? validateGstin(rawGstin) : null;
  if (rawGstin && !gstin) throw new ProfileInputError('invalid_gstin');
  if (gstin && country !== 'IN') throw new ProfileInputError('gstin_outside_india');
  let stateCode = optional(r.state_code, 2);
  if (stateCode === undefined) throw new ProfileInputError('invalid_profile');
  if (country === 'IN') {
    stateCode = stateCode ?? (gstin ? gstin.slice(0, 2) : null);
    if (!isGstStateCode(stateCode)) throw new ProfileInputError('state_required');
    if (gstin && gstin.slice(0, 2) !== stateCode) throw new ProfileInputError('gstin_state_mismatch');
  } else stateCode = null;
  return { legalName, gstin, addressLine1, addressLine2, city, stateCode, postalCode, country, email: email.toLowerCase() };
}

type Row = { legal_name: string; gstin: string | null; address_line1: string; address_line2: string | null; city: string; state_code: string | null; postal_code: string; country: string; email: string };
const fromRow = (r: Row): BillingProfile => ({
  legalName: r.legal_name, gstin: r.gstin, addressLine1: r.address_line1, addressLine2: r.address_line2, city: r.city,
  stateCode: r.state_code, postalCode: r.postal_code, country: r.country, email: r.email,
});

export async function getBillingProfile(tx: TenantTransaction, accountId: string): Promise<BillingProfile | null> {
  const rows = await tx.$queryRaw<Row[]>`
    SELECT legal_name, gstin, address_line1, address_line2, city, state_code, postal_code, country, email
    FROM billing_profiles WHERE account_id=${accountId}::uuid`;
  return rows[0] ? fromRow(rows[0]) : null;
}

/** Inserts or replaces the profile (admin, app role; RLS enforces the role). */
export async function saveBillingProfile(tx: TenantTransaction, accountId: string, p: BillingProfile): Promise<BillingProfile> {
  const rows = await tx.$queryRaw<Row[]>`
    INSERT INTO billing_profiles (account_id, legal_name, gstin, address_line1, address_line2, city, state_code, postal_code, country, email)
    VALUES (${accountId}::uuid, ${p.legalName}, ${p.gstin}, ${p.addressLine1}, ${p.addressLine2}, ${p.city}, ${p.stateCode}, ${p.postalCode}, ${p.country}, ${p.email})
    ON CONFLICT (account_id) DO UPDATE SET legal_name=EXCLUDED.legal_name, gstin=EXCLUDED.gstin, address_line1=EXCLUDED.address_line1,
      address_line2=EXCLUDED.address_line2, city=EXCLUDED.city, state_code=EXCLUDED.state_code, postal_code=EXCLUDED.postal_code,
      country=EXCLUDED.country, email=EXCLUDED.email
    RETURNING legal_name, gstin, address_line1, address_line2, city, state_code, postal_code, country, email`;
  return fromRow(rows[0]);
}
