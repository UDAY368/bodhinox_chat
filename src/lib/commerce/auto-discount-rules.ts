/**
 * Automatic discount rules in the database (store plan Phase 3). Admins
 * manage them through the app role (RLS: admins write, agents read); the
 * checkout worker reads the live ones and hands them to priceCart. The
 * arithmetic is in auto-discounts.ts. A workspace keeps at most 20 rules,
 * counted under an advisory lock so two admins cannot pass the cap together.
 * Audit rows carry field names only.
 */
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { AUTO_DISCOUNT_KINDS, AUTO_DISCOUNT_LIMITS, type AutoDiscountKind, type PricingAutoDiscount } from './auto-discounts';
import { minorFromDb } from './money';
import { auditStoreChange, isUuid, lockStoreCurrencyShared, StoreError } from './store-settings';

/** The largest amount a rule may hold (matches the table CHECK). */
const MAX_RULE_MINOR = 100_000_000_000;

interface RuleRow {
  id: string;
  name: string;
  kind: AutoDiscountKind;
  min_subtotal_minor: bigint | number;
  amount_minor: bigint | number | null;
  percent_bps: number | null;
  buy_qty: number | null;
  get_qty: number | null;
  product_ids: string[];
  active: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
  version: number;
}

export interface AutoDiscountView {
  id: string;
  name: string;
  kind: AutoDiscountKind;
  min_subtotal_minor: number;
  amount_minor: number | null;
  percent_bps: number | null;
  buy_qty: number | null;
  get_qty: number | null;
  product_ids: string[];
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  version: number;
}

export type AutoDiscountInput = Omit<AutoDiscountView, 'id' | 'version' | 'starts_at' | 'ends_at'> & { starts_at: Date | null; ends_at: Date | null };

const COLUMNS = `id::text AS id, name, kind, min_subtotal_minor, amount_minor, percent_bps, buy_qty, get_qty,
  product_ids::text[] AS product_ids, active, starts_at, ends_at, version`;

const toView = (r: RuleRow): AutoDiscountView => ({
  id: r.id, name: r.name, kind: r.kind, min_subtotal_minor: minorFromDb(r.min_subtotal_minor) ?? 0, amount_minor: minorFromDb(r.amount_minor),
  percent_bps: r.percent_bps, buy_qty: r.buy_qty, get_qty: r.get_qty, product_ids: r.product_ids ?? [], active: r.active,
  starts_at: r.starts_at?.toISOString() ?? null, ends_at: r.ends_at?.toISOString() ?? null, version: r.version,
});

const toPricing = (r: RuleRow): PricingAutoDiscount => ({
  id: r.id, name: r.name, kind: r.kind, minSubtotalMinor: minorFromDb(r.min_subtotal_minor) ?? 0, amountMinor: minorFromDb(r.amount_minor),
  percentBps: r.percent_bps, buyQty: r.buy_qty, getQty: r.get_qty, productIds: r.product_ids ?? [], active: r.active,
  startsAt: r.starts_at, endsAt: r.ends_at,
});

/**
 * The workspace's switched-on rules for pricing, in id order. The dates are
 * checked by the pricing code against its own `now`, so a quote and the place
 * that follows read the same clock.
 */
export async function loadAutoDiscountsTx(tx: TenantTransaction, accountId: string): Promise<PricingAutoDiscount[]> {
  const rows = await tx.$queryRawUnsafe<RuleRow[]>(
    `SELECT ${COLUMNS} FROM shop_auto_discounts WHERE account_id=$1::uuid AND active ORDER BY id LIMIT ${AUTO_DISCOUNT_LIMITS.maxRules}`, accountId);
  return rows.map(toPricing);
}

// ---------------------------------------------------------------------------
// Admin (app role, caller's session)

function int(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new StoreError('invalid', { field });
  return value;
}
const absent = (value: unknown) => value === null || value === undefined;
function date(value: unknown, field: string): Date | null {
  if (absent(value) || value === '') return null;
  const d = typeof value === 'string' && value.length <= 40 ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) throw new StoreError('invalid', { field });
  return d;
}

/** Validate a rule to its fixed shape: each kind takes exactly its own fields. */
export function parseAutoDiscount(body: unknown): AutoDiscountInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  // Plain text only: no control characters and no angle brackets.
  if (!name || name.length > AUTO_DISCOUNT_LIMITS.maxName || /[\p{Cc}<>]/u.test(name)) throw new StoreError('invalid', { field: 'name' });
  const kind = AUTO_DISCOUNT_KINDS.find((k) => k === b.kind);
  if (!kind) throw new StoreError('invalid', { field: 'kind' });
  if (typeof b.active !== 'boolean') throw new StoreError('invalid', { field: 'active' });
  const starts = date(b.starts_at, 'starts_at'), ends = date(b.ends_at, 'ends_at');
  if (starts && ends && ends <= starts) throw new StoreError('invalid', { field: 'ends_at' });
  const refuse = (field: string) => {
    if (!absent(b[field]) && !(field === 'product_ids' && Array.isArray(b[field]) && !(b[field] as unknown[]).length))
      throw new StoreError('invalid', { field });
  };
  let amount: number | null = null, percent: number | null = null, buy: number | null = null, get: number | null = null;
  let products: string[] = [];
  if (kind === 'amount_off_over') amount = int(b.amount_minor, 1, MAX_RULE_MINOR, 'amount_minor');
  else if (kind === 'percent_off_over') percent = int(b.percent_bps, 1, 10_000, 'percent_bps');
  else if (kind === 'prepaid') {
    // Money off for paying online: a percent or an amount, never both.
    if (absent(b.amount_minor) === absent(b.percent_bps)) throw new StoreError('invalid', { field: 'amount_minor' });
    if (absent(b.amount_minor)) percent = int(b.percent_bps, 1, 10_000, 'percent_bps');
    else amount = int(b.amount_minor, 1, MAX_RULE_MINOR, 'amount_minor');
  } else if (kind === 'buy_x_get_y') {
    buy = int(b.buy_qty, 1, AUTO_DISCOUNT_LIMITS.maxQty, 'buy_qty');
    get = int(b.get_qty, 1, AUTO_DISCOUNT_LIMITS.maxQty, 'get_qty');
    const ids = absent(b.product_ids) ? [] : b.product_ids;
    if (!Array.isArray(ids) || ids.length > AUTO_DISCOUNT_LIMITS.maxProducts || ids.some((id) => !isUuid(id)))
      throw new StoreError('invalid', { field: 'product_ids' });
    products = [...new Set((ids as string[]).map((id) => id.toLowerCase()))];
  }
  if (amount === null) refuse('amount_minor');
  if (percent === null) refuse('percent_bps');
  if (kind !== 'buy_x_get_y') ['buy_qty', 'get_qty', 'product_ids'].forEach(refuse);
  return {
    name, kind, min_subtotal_minor: int(b.min_subtotal_minor ?? 0, 0, MAX_RULE_MINOR, 'min_subtotal_minor'), amount_minor: amount,
    percent_bps: percent, buy_qty: buy, get_qty: get, product_ids: products, active: b.active, starts_at: starts, ends_at: ends,
  };
}

async function select(tx: TenantTransaction, accountId: string, id: string | null): Promise<AutoDiscountView[]> {
  const rows = await tx.$queryRawUnsafe<RuleRow[]>(
    `SELECT ${COLUMNS} FROM shop_auto_discounts WHERE account_id=$1::uuid AND ($2::uuid IS NULL OR id=$2::uuid)
     ORDER BY created_at, id LIMIT ${AUTO_DISCOUNT_LIMITS.maxRules}`, accountId, id);
  return rows.map(toView);
}

export async function listAutoDiscounts(ctx: TenantContext): Promise<AutoDiscountView[]> {
  return withTenant(ctx, (tx) => select(tx, ctx.accountId, null));
}

/** Every product a buy X get Y rule names must be one of this workspace's products. */
async function assertProducts(tx: TenantTransaction, accountId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const [row] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shop_products
    WHERE account_id=${accountId}::uuid AND id = ANY(${ids}::uuid[])`;
  if ((row?.n ?? 0) !== ids.length) throw new StoreError('invalid', { field: 'product_ids' });
}

export async function createAutoDiscount(ctx: TenantContext & { userId: string }, input: AutoDiscountInput): Promise<AutoDiscountView> {
  return withTenant(ctx, async (tx) => {
    await lockStoreCurrencyShared(tx, ctx.accountId); // a rule's amounts are in the store currency
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auto-discounts:${ctx.accountId}`}, 0))`;
    const [count] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shop_auto_discounts WHERE account_id=${ctx.accountId}::uuid`;
    if ((count?.n ?? 0) >= AUTO_DISCOUNT_LIMITS.maxRules) throw new StoreError('auto_discount_limit');
    await assertProducts(tx, ctx.accountId, input.product_ids);
    const [row] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO shop_auto_discounts(account_id,name,kind,min_subtotal_minor,amount_minor,
        percent_bps,buy_qty,get_qty,product_ids,active,starts_at,ends_at,created_by)
      VALUES(${ctx.accountId}::uuid,${input.name},${input.kind},${input.min_subtotal_minor},${input.amount_minor},${input.percent_bps},
        ${input.buy_qty},${input.get_qty},${input.product_ids}::uuid[],${input.active},${input.starts_at},${input.ends_at},${ctx.userId}::uuid)
      RETURNING id::text AS id`;
    await auditStoreChange(tx, ctx, 'commerce.auto_discount_created', row.id, { kind: input.kind });
    return (await select(tx, ctx.accountId, row.id))[0];
  });
}

/** Replace a rule's fields. `expectedVersion` must be the version the admin loaded (409 conflict otherwise). */
export async function updateAutoDiscount(ctx: TenantContext & { userId: string }, id: string, expectedVersion: unknown,
  input: AutoDiscountInput): Promise<AutoDiscountView> {
  if (!isUuid(id)) throw new StoreError('not_found');
  if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1)
    throw new StoreError('invalid', { field: 'expected_version' });
  return withTenant(ctx, async (tx) => {
    await lockStoreCurrencyShared(tx, ctx.accountId);
    await assertProducts(tx, ctx.accountId, input.product_ids);
    const changed = await tx.$executeRaw`UPDATE shop_auto_discounts SET name=${input.name},kind=${input.kind},
        min_subtotal_minor=${input.min_subtotal_minor},amount_minor=${input.amount_minor},percent_bps=${input.percent_bps},
        buy_qty=${input.buy_qty},get_qty=${input.get_qty},product_ids=${input.product_ids}::uuid[],active=${input.active},
        starts_at=${input.starts_at},ends_at=${input.ends_at},version=version+1
      WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid AND version=${expectedVersion}`;
    if (!changed) {
      const [exists] = await select(tx, ctx.accountId, id);
      throw new StoreError(exists ? 'conflict' : 'not_found');
    }
    await auditStoreChange(tx, ctx, 'commerce.auto_discount_updated', id, { kind: input.kind, active: input.active });
    return (await select(tx, ctx.accountId, id))[0];
  });
}

export async function deleteAutoDiscount(ctx: TenantContext & { userId: string }, id: string): Promise<void> {
  if (!isUuid(id)) throw new StoreError('not_found');
  await withTenant(ctx, async (tx) => {
    const removed = await tx.$executeRaw`DELETE FROM shop_auto_discounts WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
    if (!removed) throw new StoreError('not_found');
    await auditStoreChange(tx, ctx, 'commerce.auto_discount_deleted', id);
  });
}
