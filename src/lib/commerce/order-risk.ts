/**
 * Rule-based order risk (store plan Phase 8). A pure function over a few facts,
 * and a loader that gathers the facts for a page of orders at read time (no
 * stored column, no job). The result is a hint for staff, never a block: the
 * reasons are fixed keys the screens translate.
 */

import type { TenantTransaction } from '@/lib/db/tenant';

export type RiskLevel = 'low' | 'medium' | 'high';
export type RiskReason = 'cod_history' | 'cod_declined' | 'order_burst' | 'pincode_missing' | 'pincode_invalid' | 'high_first_order';
export interface OrderRisk { level: RiskLevel; reasons: RiskReason[] }

export const RISK_RULES = {
  /** Orders by one contact within this window of the order (itself included) that count as a burst. */
  burstWindowMs: 3_600_000,
  burstOrders: 3,
  /** A first order this many times the shop's typical order is flagged, once the shop has enough history. */
  highFirstFactor: 3,
  typicalMinSample: 10,
  typicalDays: 90,
} as const;

export interface RiskFacts {
  /** Earlier cash-on-delivery orders of this buyer that were cancelled, refused, returned or declined. */
  badCodCount: number;
  /** The buyer declined this order's COD confirmation. */
  codDeclined: boolean;
  /** Orders of this buyer within the burst window of this order, itself included. */
  burstCount: number;
  /** The delivery address: undefined when none was collected yet, else its country and postal code. */
  address?: { country: string | null; postalCode: string | null };
  /** True when the buyer has no earlier order. */
  firstOrder: boolean;
  totalMinor: number;
  /** The shop's median recent order, null without enough history. */
  typicalMinor: number | null;
}

/** Indian pincodes are six digits and never start with 0; other countries are not checked. */
export function pincodeProblem(address: NonNullable<RiskFacts['address']>): 'pincode_missing' | 'pincode_invalid' | null {
  const postal = (address.postalCode ?? '').trim();
  if (!postal) return 'pincode_missing';
  return (address.country ?? 'IN').toUpperCase() === 'IN' && !/^[1-9][0-9]{5}$/.test(postal) ? 'pincode_invalid' : null;
}

const WEIGHT: Record<RiskReason, number> = {
  cod_history: 1, cod_declined: 2, order_burst: 2, pincode_missing: 1, pincode_invalid: 1, high_first_order: 1,
};

/** 0 points low, 1-2 medium, 3 or more high; two earlier bad COD orders count double. */
export function assessOrderRisk(f: RiskFacts): OrderRisk {
  const reasons: RiskReason[] = [];
  if (f.badCodCount > 0) reasons.push('cod_history');
  if (f.codDeclined) reasons.push('cod_declined');
  if (f.burstCount >= RISK_RULES.burstOrders) reasons.push('order_burst');
  const pin = f.address ? pincodeProblem(f.address) : null;
  if (pin) reasons.push(pin);
  if (f.firstOrder && f.typicalMinor !== null && f.typicalMinor > 0 && f.totalMinor >= f.typicalMinor * RISK_RULES.highFirstFactor)
    reasons.push('high_first_order');
  const score = reasons.reduce((s, r) => s + WEIGHT[r], 0) + (f.badCodCount >= 2 ? 1 : 0);
  return { level: score === 0 ? 'low' : score <= 2 ? 'medium' : 'high', reasons };
}

export interface RiskRow {
  id: string;
  contact_id: string | null;
  created_at: Date;
  payment_method: string;
  cod_confirmation: string | null;
  shipping_address: unknown;
  subtotal_minor: bigint;
  total_minor: bigint | null;
}

const BAD_COD = new Set(['cancelled']);

function addressOf(value: unknown): RiskFacts['address'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const a = value as Record<string, unknown>;
  return { country: typeof a.country === 'string' ? a.country : null, postalCode: typeof a.postal_code === 'string' ? a.postal_code : null };
}

/** The risk of each row, by order id. Reads only the caller's workspace (tx is inside withTenant). */
export async function loadOrderRisks(tx: TenantTransaction, accountId: string, rows: RiskRow[]): Promise<Map<string, OrderRisk>> {
  const out = new Map<string, OrderRisk>();
  if (!rows.length) return out;
  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((v): v is string => Boolean(v)))];
  const [typical] = await tx.$queryRaw<{ median: number | null; n: number }[]>`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY total_minor)::float8 AS median, count(*)::int AS n FROM orders
    WHERE account_id=${accountId}::uuid AND total_minor IS NOT NULL AND status NOT IN ('cancelled','expired')
      AND created_at > now() - make_interval(days => ${RISK_RULES.typicalDays})`;
  const typicalMinor = typical && typical.n >= RISK_RULES.typicalMinSample ? typical.median : null;
  const history = contactIds.length ? await tx.$queryRaw<{ id: string; contact_id: string; created_at: Date; payment_method: string;
    status: string; cod_confirmation: string | null }[]>`
    SELECT id::text AS id, contact_id::text AS contact_id, created_at, payment_method, status, cod_confirmation FROM orders
    WHERE account_id=${accountId}::uuid AND contact_id = ANY(${contactIds}::uuid[]) ORDER BY created_at DESC LIMIT 5000` : [];
  const codIds = history.filter((h) => h.payment_method === 'cod').map((h) => h.id);
  const refused = new Set(codIds.length ? (await tx.$queryRaw<{ order_id: string }[]>`
    SELECT order_id::text AS order_id FROM order_shipments WHERE account_id=${accountId}::uuid AND order_id = ANY(${codIds}::uuid[])
      AND tracking_status ILIKE 'rto%'
    UNION SELECT order_id::text FROM order_returns WHERE account_id=${accountId}::uuid AND order_id = ANY(${codIds}::uuid[])`).map((r) => r.order_id) : []);
  for (const row of rows) {
    const own = row.contact_id ? history.filter((h) => h.contact_id === row.contact_id) : [];
    const at = row.created_at.getTime();
    const earlier = own.filter((h) => h.id !== row.id && h.created_at.getTime() < at);
    out.set(row.id, assessOrderRisk({
      badCodCount: earlier.filter((h) => h.payment_method === 'cod'
        && (BAD_COD.has(h.status) || h.cod_confirmation === 'declined' || refused.has(h.id))).length,
      codDeclined: row.payment_method === 'cod' && row.cod_confirmation === 'declined',
      burstCount: row.contact_id ? own.filter((h) => Math.abs(h.created_at.getTime() - at) <= RISK_RULES.burstWindowMs).length : 0,
      address: addressOf(row.shipping_address),
      firstOrder: Boolean(row.contact_id) && earlier.length === 0,
      totalMinor: Number(row.total_minor ?? row.subtotal_minor),
      typicalMinor,
    }));
  }
  return out;
}
