/**
 * Coupons (design §3 Pricing and checkout). Admins manage them through the
 * app role (code, kind and value are fixed once created: redemptions refer to
 * them). Checkout redeems inside its worker transaction:
 *
 *   lockCouponTx   advisory lock per coupon (lock order: order -> coupon -> inventory)
 *   redeemCouponTx count the coupon's non-released redemptions overall and
 *                  for the contact under that lock, then record one for the
 *                  order, so concurrent checkouts can never exceed a limit.
 *   releaseCouponTx on expiry or cancel.
 */
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { MAX_MINOR, minorFromDb } from './money';
import { couponDiscount, type PricingCoupon } from './pricing';
import { auditStoreChange, isUuid, lockStoreCurrencyShared, StoreError } from './store-settings';

export const COUPON_CODE = /^[A-Z0-9_-]{3,32}$/;

export interface CouponRow {
  id: string;
  code: string;
  kind: 'percent' | 'fixed';
  value: bigint | number;
  min_subtotal_minor: bigint | number;
  max_discount_minor: bigint | number | null;
  starts_at: Date | null;
  ends_at: Date | null;
  max_redemptions: number | null;
  per_contact_limit: number | null;
  active: boolean;
}

export interface CouponView {
  id: string;
  code: string;
  kind: 'percent' | 'fixed';
  value: number;
  min_subtotal_minor: number;
  max_discount_minor: number | null;
  starts_at: string | null;
  ends_at: string | null;
  max_redemptions: number | null;
  per_contact_limit: number | null;
  active: boolean;
  redemptions: number;
}

const COLUMNS = `id::text AS id, code, kind, value, min_subtotal_minor, max_discount_minor, starts_at, ends_at, max_redemptions,
  per_contact_limit, active`;

export const toPricingCoupon = (row: CouponRow): PricingCoupon => ({
  code: row.code, kind: row.kind, value: minorFromDb(row.value) ?? 0, minSubtotalMinor: minorFromDb(row.min_subtotal_minor) ?? 0,
  maxDiscountMinor: minorFromDb(row.max_discount_minor), startsAt: row.starts_at, endsAt: row.ends_at, active: row.active,
});

/** Normalise a customer-typed code; null when it cannot be a code. */
export function normaliseCouponCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return COUPON_CODE.test(code) ? code : null;
}

/** Pure check of a coupon against a subtotal (used for display; checkout re-checks under the lock). */
export function validateCoupon(coupon: PricingCoupon, subtotalMinor: number, now = new Date()) {
  return couponDiscount(coupon, subtotalMinor, now);
}

export async function findCouponTx(tx: TenantTransaction, accountId: string, code: string): Promise<CouponRow | null> {
  const rows = await tx.$queryRawUnsafe<CouponRow[]>(`SELECT ${COLUMNS} FROM coupons WHERE account_id=$1::uuid AND code=$2`, accountId, code);
  return rows[0] ?? null;
}

/**
 * Serialise redemptions of one coupon for the rest of the transaction, then
 * read it. The worker holds only SELECT on coupons (admins own the rows), and
 * a row lock needs UPDATE privilege, so the lock is a transaction-scoped
 * advisory lock on (account, code): same effect, same place in the lock order.
 */
export async function lockCouponTx(tx: TenantTransaction, accountId: string, code: string): Promise<CouponRow | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`coupon:${accountId}:${code}`}, 0))`;
  return findCouponTx(tx, accountId, code);
}

/**
 * Record the order's redemption of a coupon the caller already locked
 * (lockCouponTx). Throws StoreError coupon_exhausted / coupon_limit_reached.
 */
export async function redeemCouponTx(tx: TenantTransaction, accountId: string, input: {
  coupon: CouponRow; orderId: string; contactId: string | null;
}): Promise<void> {
  const { coupon } = input;
  const [counts] = await tx.$queryRaw<{ total: number; mine: number }[]>`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE contact_id IS NOT DISTINCT FROM ${input.contactId}::uuid AND ${input.contactId}::uuid IS NOT NULL)::int AS mine
    FROM coupon_redemptions
    WHERE account_id=${accountId}::uuid AND coupon_id=${coupon.id}::uuid AND status<>'released' AND order_id<>${input.orderId}::uuid`;
  if (coupon.max_redemptions !== null && counts.total >= coupon.max_redemptions) throw new StoreError('coupon_exhausted');
  if (coupon.per_contact_limit !== null && input.contactId && counts.mine >= coupon.per_contact_limit) throw new StoreError('coupon_limit_reached');
  await tx.$executeRaw`INSERT INTO coupon_redemptions(account_id,coupon_id,order_id,contact_id,status)
    VALUES(${accountId}::uuid,${coupon.id}::uuid,${input.orderId}::uuid,${input.contactId}::uuid,'reserved')
    ON CONFLICT (account_id,order_id) DO UPDATE SET coupon_id=EXCLUDED.coupon_id,contact_id=EXCLUDED.contact_id,status='reserved'`;
}

/** Release the order's coupon redemption (expiry, cancel). A no-op without one. */
export async function releaseCouponTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<void> {
  await tx.$executeRaw`UPDATE coupon_redemptions SET status='released'
    WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND status='reserved'`;
}

// ---------------------------------------------------------------------------
// Admin (app role, caller's session)

const toView = (r: CouponRow & { redemptions: number }): CouponView => ({
  id: r.id, code: r.code, kind: r.kind, value: minorFromDb(r.value) ?? 0, min_subtotal_minor: minorFromDb(r.min_subtotal_minor) ?? 0,
  max_discount_minor: minorFromDb(r.max_discount_minor), starts_at: r.starts_at?.toISOString() ?? null,
  ends_at: r.ends_at?.toISOString() ?? null, max_redemptions: r.max_redemptions, per_contact_limit: r.per_contact_limit,
  active: r.active, redemptions: r.redemptions,
});

async function selectView(tx: TenantTransaction, accountId: string, id: string | null): Promise<CouponView[]> {
  const rows = await tx.$queryRawUnsafe<(CouponRow & { redemptions: number })[]>(
    `SELECT c.id::text AS id, c.code, c.kind, c.value, c.min_subtotal_minor, c.max_discount_minor, c.starts_at, c.ends_at,
      c.max_redemptions, c.per_contact_limit, c.active,
      (SELECT count(*)::int FROM coupon_redemptions r WHERE r.account_id=c.account_id AND r.coupon_id=c.id AND r.status<>'released') AS redemptions
     FROM coupons c WHERE c.account_id=$1::uuid AND ($2::uuid IS NULL OR c.id=$2::uuid) ORDER BY c.created_at DESC LIMIT 500`,
    accountId, id);
  return rows.map(toView);
}

export async function listCoupons(ctx: TenantContext): Promise<CouponView[]> {
  return withTenant(ctx, (tx) => selectView(tx, ctx.accountId, null));
}

export interface CouponUpdate {
  min_subtotal_minor: number;
  max_discount_minor: number | null;
  starts_at: Date | null;
  ends_at: Date | null;
  max_redemptions: number | null;
  per_contact_limit: number | null;
  active: boolean;
}
export interface CouponCreate extends CouponUpdate {
  code: string;
  kind: 'percent' | 'fixed';
  value: number;
}

const amount = (value: unknown, field: string, allowNull: boolean): number | null => {
  if (allowNull && (value === null || value === undefined)) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_MINOR) throw new StoreError('invalid', { field });
  return value;
};
const limit = (value: unknown, field: string): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1_000_000) throw new StoreError('invalid', { field });
  return value;
};
const date = (value: unknown, field: string): Date | null => {
  if (value === null || value === undefined || value === '') return null;
  const d = typeof value === 'string' && value.length <= 40 ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) throw new StoreError('invalid', { field });
  return d;
};

export function parseCouponUpdate(body: unknown): CouponUpdate {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  if (typeof b.active !== 'boolean') throw new StoreError('invalid', { field: 'active' });
  const maxDiscount = amount(b.max_discount_minor, 'max_discount_minor', true);
  if (maxDiscount === 0) throw new StoreError('invalid', { field: 'max_discount_minor' });
  const starts = date(b.starts_at, 'starts_at'), ends = date(b.ends_at, 'ends_at');
  if (starts && ends && ends <= starts) throw new StoreError('invalid', { field: 'ends_at' });
  return {
    min_subtotal_minor: amount(b.min_subtotal_minor ?? 0, 'min_subtotal_minor', false)!, max_discount_minor: maxDiscount,
    starts_at: starts, ends_at: ends, max_redemptions: limit(b.max_redemptions, 'max_redemptions'),
    per_contact_limit: limit(b.per_contact_limit, 'per_contact_limit'), active: b.active,
  };
}

export function parseCouponCreate(body: unknown): CouponCreate {
  const update = parseCouponUpdate(body);
  const b = body as Record<string, unknown>;
  const code = normaliseCouponCode(b.code);
  if (!code) throw new StoreError('invalid', { field: 'code' });
  if (b.kind !== 'percent' && b.kind !== 'fixed') throw new StoreError('invalid', { field: 'kind' });
  const value = amount(b.value, 'value', false)!;
  if (value < 1 || (b.kind === 'percent' && value > 10000)) throw new StoreError('invalid', { field: 'value' });
  return { ...update, code, kind: b.kind, value };
}

export async function createCoupon(ctx: TenantContext & { userId: string }, input: CouponCreate): Promise<CouponView> {
  return withTenant(ctx, async (tx) => {
    await lockStoreCurrencyShared(tx, ctx.accountId); // a coupon amount is in the store currency
    const rows = await tx.$queryRaw<{ id: string }[]>`INSERT INTO coupons(account_id,code,kind,value,min_subtotal_minor,max_discount_minor,
        starts_at,ends_at,max_redemptions,per_contact_limit,active,created_by)
      VALUES(${ctx.accountId}::uuid,${input.code},${input.kind},${input.value},${input.min_subtotal_minor},${input.max_discount_minor},
        ${input.starts_at},${input.ends_at},${input.max_redemptions},${input.per_contact_limit},${input.active},${ctx.userId}::uuid)
      ON CONFLICT (account_id,code) DO NOTHING RETURNING id::text AS id`;
    if (!rows[0]) throw new StoreError('coupon_code_taken');
    await auditStoreChange(tx, ctx, 'commerce.coupon_created', rows[0].id, { kind: input.kind });
    return (await selectView(tx, ctx.accountId, rows[0].id))[0];
  });
}

export async function updateCoupon(ctx: TenantContext & { userId: string }, id: string, input: CouponUpdate): Promise<CouponView> {
  if (!isUuid(id)) throw new StoreError('not_found');
  return withTenant(ctx, async (tx) => {
    await lockStoreCurrencyShared(tx, ctx.accountId);
    const changed = await tx.$executeRaw`UPDATE coupons SET min_subtotal_minor=${input.min_subtotal_minor},
        max_discount_minor=${input.max_discount_minor},starts_at=${input.starts_at},ends_at=${input.ends_at},
        max_redemptions=${input.max_redemptions},per_contact_limit=${input.per_contact_limit},active=${input.active}
      WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
    if (!changed) throw new StoreError('not_found');
    await auditStoreChange(tx, ctx, 'commerce.coupon_updated', id, { active: input.active });
    return (await selectView(tx, ctx.accountId, id))[0];
  });
}
