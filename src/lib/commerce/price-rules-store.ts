/**
 * Price lists, discount rules and gift rules in the database (store plan
 * Phase 8). Admins manage them through the app role (RLS: admins write,
 * agents read); pricing reads the ones that reach a buyer through
 * loadBuyerPricingTx and hands them to priceCart. The arithmetic and the
 * stacking order are in price-rules.ts.
 *
 * A customer group is a list of contacts that only admins change (its own
 * tables, admin-write under RLS): a price list names one group, a discount
 * rule may name one. Contact tags play no part, so tagging a contact never
 * changes a price. Counts are capped under an advisory lock; edits are
 * version-checked; audit rows carry ids and field names only.
 */
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { minorFromDb } from './money';
import { PRICE_RULE_LIMITS, type PricingGiftRule, type PricingLineRule, type PricingPriceTier } from './price-rules';
import { auditStoreChange, isUuid, lockStoreCurrencyShared, StoreError } from './store-settings';

const MAX_RULE_MINOR = 100_000_000_000;
type Admin = TenantContext & { userId: string };

// ---------------------------------------------------------------------------
// Pricing loader (worker or staff transaction)

export interface BuyerPricing {
  priceTiers: PricingPriceTier[];
  lineRules: PricingLineRule[];
  giftRules: PricingGiftRule[];
}

/**
 * Everything priceCart needs about this buyer: the price-list entries of the
 * customer groups the contact is in for these variants, the discount rules for
 * everyone or for one of those groups, and the workspace's gift rules. Dates
 * are checked by the pricing code against its own clock. No contact (an
 * anonymous cart) gets only the rules meant for everyone.
 */
export async function loadBuyerPricingTx(tx: TenantTransaction, accountId: string, contactId: string | null, variantIds: string[]): Promise<BuyerPricing> {
  const groups = contactId ? (await tx.$queryRaw<{ id: string }[]>`
    SELECT group_id::text AS id FROM shop_customer_group_members
    WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid`).map((g) => g.id) : [];
  const tiers = groups.length && variantIds.length ? await tx.$queryRaw<{ variant_id: string; min_qty: number; price_minor: bigint }[]>`
    SELECT p.variant_id::text AS variant_id, p.min_qty, p.price_minor FROM shop_price_list_prices p
    JOIN shop_price_lists l ON l.account_id=p.account_id AND l.id=p.price_list_id
    WHERE p.account_id=${accountId}::uuid AND l.active AND l.group_id = ANY(${groups}::uuid[]) AND p.variant_id = ANY(${variantIds}::uuid[])
    ORDER BY p.variant_id, p.min_qty, p.price_minor` : [];
  const rules = await tx.$queryRaw<{ id: string; name: string; product_id: string | null; category_ids: string[] | null; kind: 'percent' | 'fixed';
    value: bigint; combinable: boolean; starts_at: Date | null; ends_at: Date | null }[]>`
    SELECT r.id::text AS id, r.name, r.product_id::text AS product_id, r.kind, r.value, r.combinable, r.starts_at, r.ends_at,
      CASE WHEN r.category_id IS NULL THEN NULL ELSE (
        WITH RECURSIVE tree AS (
          SELECT c.id FROM shop_categories c WHERE c.account_id=r.account_id AND c.id=r.category_id
          UNION SELECT c.id FROM shop_categories c JOIN tree t ON c.parent_id=t.id WHERE c.account_id=r.account_id)
        SELECT array_agg(id::text) FROM tree) END AS category_ids
    FROM shop_discount_rules r
    WHERE r.account_id=${accountId}::uuid AND r.active AND (r.group_id IS NULL OR r.group_id = ANY(${groups}::uuid[]))
    ORDER BY r.id LIMIT ${PRICE_RULE_LIMITS.maxRules}`;
  const gifts = await tx.$queryRaw<{ id: string; name: string; min_subtotal_minor: bigint | null; trigger_product_id: string | null;
    gift_variant_id: string; starts_at: Date | null; ends_at: Date | null }[]>`
    SELECT id::text AS id, name, min_subtotal_minor, trigger_product_id::text AS trigger_product_id, gift_variant_id::text AS gift_variant_id,
      starts_at, ends_at
    FROM shop_gift_rules WHERE account_id=${accountId}::uuid AND active ORDER BY id LIMIT ${PRICE_RULE_LIMITS.maxGiftRules}`;
  return {
    priceTiers: tiers.map((t) => ({ variantId: t.variant_id, minQty: t.min_qty, priceMinor: minorFromDb(t.price_minor) ?? 0 })),
    lineRules: rules.map((r) => ({
      id: r.id, name: r.name, productId: r.product_id, categoryIds: r.category_ids, kind: r.kind, value: minorFromDb(r.value) ?? 0,
      combinable: r.combinable, active: true, startsAt: r.starts_at, endsAt: r.ends_at,
    })),
    giftRules: gifts.map((g) => ({
      id: g.id, name: g.name, minSubtotalMinor: minorFromDb(g.min_subtotal_minor), triggerProductId: g.trigger_product_id,
      giftVariantId: g.gift_variant_id, active: true, startsAt: g.starts_at, endsAt: g.ends_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// Validation helpers

function object(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  return body as Record<string, unknown>;
}
function int(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new StoreError('invalid', { field });
  return value;
}
const absent = (value: unknown) => value === null || value === undefined || value === '';
function name(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  // Plain text only: no control characters and no angle brackets.
  if (!text || text.length > PRICE_RULE_LIMITS.maxName || /[\p{Cc}<>]/u.test(text)) throw new StoreError('invalid', { field: 'name' });
  return text;
}
function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new StoreError('invalid', { field });
  return value;
}
function id(value: unknown, field: string): string {
  if (!isUuid(value)) throw new StoreError('invalid', { field });
  return value.toLowerCase();
}
const optionalId = (value: unknown, field: string) => (absent(value) ? null : id(value, field));
function date(value: unknown, field: string): Date | null {
  if (absent(value)) return null;
  const d = typeof value === 'string' && value.length <= 40 ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) throw new StoreError('invalid', { field });
  return d;
}
function dates(b: Record<string, unknown>): { starts_at: Date | null; ends_at: Date | null } {
  const starts_at = date(b.starts_at, 'starts_at'), ends_at = date(b.ends_at, 'ends_at');
  if (starts_at && ends_at && ends_at <= starts_at) throw new StoreError('invalid', { field: 'ends_at' });
  return { starts_at, ends_at };
}
function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new StoreError('invalid', { field: 'expected_version' });
  return value;
}

/** Every id must be a row of this workspace's table (RLS already hides other workspaces). */
async function assertOwned(tx: TenantTransaction, accountId: string, table: 'shop_customer_groups' | 'shop_products' | 'shop_categories' | 'shop_variants' | 'contacts',
  ids: Array<string | null>, field: string): Promise<void> {
  const wanted = [...new Set(ids.filter((x): x is string => x !== null))];
  if (!wanted.length) return;
  const [row] = await tx.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM ${table} WHERE account_id=$1::uuid AND id = ANY($2::uuid[])`, accountId, wanted);
  if ((row?.n ?? 0) !== wanted.length) throw new StoreError('invalid', { field });
}

async function capped(tx: TenantTransaction, accountId: string,
  table: 'shop_customer_groups' | 'shop_price_lists' | 'shop_discount_rules' | 'shop_gift_rules', max: number) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${table}:${accountId}`}, 0))`;
  const [count] = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table} WHERE account_id=$1::uuid`, accountId);
  if ((count?.n ?? 0) >= max) throw new StoreError('price_rule_limit');
}

async function remove(ctx: Admin, table: 'shop_customer_groups' | 'shop_price_lists' | 'shop_discount_rules' | 'shop_gift_rules', rowId: string,
  action: string): Promise<void> {
  if (!isUuid(rowId)) throw new StoreError('not_found');
  await withTenant(ctx, async (tx) => {
    const removed = await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE account_id=$1::uuid AND id=$2::uuid`, ctx.accountId, rowId);
    if (!removed) throw new StoreError('not_found');
    await auditStoreChange(tx, ctx, action, rowId);
  });
}

// ---------------------------------------------------------------------------
// Customer groups (admins only; RLS refuses every other writer)

export interface CustomerGroupView {
  id: string;
  name: string;
  member_count: number;
  /** The first 200 members by name. */
  members: Array<{ contact_id: string; name: string | null; phone: string | null }>;
}

export function parseCustomerGroup(body: unknown): { name: string } {
  return { name: name(object(body).name) };
}

async function selectGroups(tx: TenantTransaction, accountId: string, only: string | null): Promise<CustomerGroupView[]> {
  const groups = await tx.$queryRaw<{ id: string; name: string; member_count: number }[]>`
    SELECT g.id::text AS id, g.name,
      (SELECT count(*)::int FROM shop_customer_group_members m WHERE m.account_id=g.account_id AND m.group_id=g.id) AS member_count
    FROM shop_customer_groups g WHERE g.account_id=${accountId}::uuid AND (${only}::uuid IS NULL OR g.id=${only}::uuid)
    ORDER BY lower(g.name), g.id LIMIT ${PRICE_RULE_LIMITS.maxGroups}`;
  const out: CustomerGroupView[] = [];
  for (const g of groups) {
    const members = await tx.$queryRaw<{ contact_id: string; name: string | null; phone: string | null }[]>`
      SELECT m.contact_id::text AS contact_id, c.name, c.phone FROM shop_customer_group_members m
      JOIN contacts c ON c.account_id=m.account_id AND c.id=m.contact_id
      WHERE m.account_id=${accountId}::uuid AND m.group_id=${g.id}::uuid ORDER BY lower(c.name), c.id LIMIT 200`;
    out.push({ ...g, members });
  }
  return out;
}

export function listCustomerGroups(ctx: TenantContext): Promise<CustomerGroupView[]> {
  return withTenant(ctx, (tx) => selectGroups(tx, ctx.accountId, null));
}

export async function createCustomerGroup(ctx: Admin, input: { name: string }): Promise<CustomerGroupView> {
  return withTenant(ctx, async (tx) => {
    await capped(tx, ctx.accountId, 'shop_customer_groups', PRICE_RULE_LIMITS.maxGroups);
    const [taken] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_customer_groups
      WHERE account_id=${ctx.accountId}::uuid AND lower(name)=lower(${input.name})`;
    if (taken) throw new StoreError('invalid', { field: 'name' });
    const [row] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO shop_customer_groups(account_id,name,created_by)
      VALUES(${ctx.accountId}::uuid,${input.name},${ctx.userId}::uuid) RETURNING id::text AS id`;
    await auditStoreChange(tx, ctx, 'commerce.customer_group_created', row.id);
    return (await selectGroups(tx, ctx.accountId, row.id))[0];
  });
}

/** Deleting a group also deletes the price lists and discount rules that name it (they would reach nobody). */
export const deleteCustomerGroup = (ctx: Admin, groupId: string) => remove(ctx, 'shop_customer_groups', groupId, 'commerce.customer_group_deleted');

/** Put a contact into a group, or take it out. Admins only; a repeat changes nothing. */
export async function setGroupMember(ctx: Admin, groupId: string, contactId: unknown, member: boolean): Promise<CustomerGroupView> {
  if (!isUuid(groupId)) throw new StoreError('not_found');
  if (!isUuid(contactId)) throw new StoreError('invalid', { field: 'contact_id' });
  return withTenant(ctx, async (tx) => {
    if (!(await selectGroups(tx, ctx.accountId, groupId)).length) throw new StoreError('not_found');
    if (member) {
      await assertOwned(tx, ctx.accountId, 'contacts', [contactId], 'contact_id');
      const [count] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shop_customer_group_members
        WHERE account_id=${ctx.accountId}::uuid AND group_id=${groupId}::uuid`;
      if ((count?.n ?? 0) >= PRICE_RULE_LIMITS.maxGroupMembers) throw new StoreError('price_rule_limit');
      const added = await tx.$executeRaw`INSERT INTO shop_customer_group_members(account_id,group_id,contact_id,added_by)
        VALUES(${ctx.accountId}::uuid,${groupId}::uuid,${contactId}::uuid,${ctx.userId}::uuid) ON CONFLICT DO NOTHING`;
      if (added) await auditStoreChange(tx, ctx, 'commerce.customer_group_member_added', groupId, { contact_id: contactId });
    } else {
      const removed = await tx.$executeRaw`DELETE FROM shop_customer_group_members
        WHERE account_id=${ctx.accountId}::uuid AND group_id=${groupId}::uuid AND contact_id=${contactId}::uuid`;
      if (removed) await auditStoreChange(tx, ctx, 'commerce.customer_group_member_removed', groupId, { contact_id: contactId });
    }
    return (await selectGroups(tx, ctx.accountId, groupId))[0];
  });
}

// ---------------------------------------------------------------------------
// Price lists

export interface PriceListPrice { variant_id: string; min_qty: number; price_minor: number; variant_name?: string; sku?: string }
export interface PriceListView {
  id: string; name: string; group_id: string; group_name: string | null; active: boolean; version: number; prices: PriceListPrice[];
}
export interface PriceListInput { name: string; group_id: string; active: boolean; prices: PriceListPrice[] }

export function parsePriceList(body: unknown): PriceListInput {
  const b = object(body);
  if (!Array.isArray(b.prices) || b.prices.length > PRICE_RULE_LIMITS.maxPrices) throw new StoreError('invalid', { field: 'prices' });
  const seen = new Set<string>();
  const prices = b.prices.map((raw) => {
    const p = object(raw);
    const price = { variant_id: id(p.variant_id, 'prices'), min_qty: int(p.min_qty ?? 1, 1, 99, 'prices'), price_minor: int(p.price_minor, 0, MAX_RULE_MINOR, 'prices') };
    const key = `${price.variant_id}:${price.min_qty}`;
    if (seen.has(key)) throw new StoreError('invalid', { field: 'prices' });
    seen.add(key);
    return price;
  });
  return { name: name(b.name), group_id: id(b.group_id, 'group_id'), active: bool(b.active, 'active'), prices };
}

async function selectPriceLists(tx: TenantTransaction, accountId: string, only: string | null): Promise<PriceListView[]> {
  const lists = await tx.$queryRaw<{ id: string; name: string; group_id: string; group_name: string | null; active: boolean; version: number }[]>`
    SELECT l.id::text AS id, l.name, l.group_id::text AS group_id, t.name AS group_name, l.active, l.version
    FROM shop_price_lists l LEFT JOIN shop_customer_groups t ON t.account_id=l.account_id AND t.id=l.group_id
    WHERE l.account_id=${accountId}::uuid AND (${only}::uuid IS NULL OR l.id=${only}::uuid)
    ORDER BY l.created_at, l.id LIMIT ${PRICE_RULE_LIMITS.maxLists}`;
  if (!lists.length) return [];
  const prices = await tx.$queryRaw<{ price_list_id: string; variant_id: string; min_qty: number; price_minor: bigint; product_name: string;
    option_values: Record<string, string> | null; sku: string }[]>`
    SELECT p.price_list_id::text AS price_list_id, p.variant_id::text AS variant_id, p.min_qty, p.price_minor, sp.name AS product_name,
      v.option_values, v.sku
    FROM shop_price_list_prices p
    JOIN shop_variants v ON v.account_id=p.account_id AND v.id=p.variant_id
    JOIN shop_products sp ON sp.account_id=v.account_id AND sp.id=v.product_id
    WHERE p.account_id=${accountId}::uuid AND p.price_list_id = ANY(${lists.map((l) => l.id)}::uuid[])
    ORDER BY lower(sp.name), v.sku, p.min_qty`;
  return lists.map((l) => ({
    ...l,
    prices: prices.filter((p) => p.price_list_id === l.id).map((p) => {
      const options = Object.values(p.option_values ?? {}).filter(Boolean).join(' / ');
      return {
        variant_id: p.variant_id, min_qty: p.min_qty, price_minor: minorFromDb(p.price_minor) ?? 0,
        variant_name: options ? `${p.product_name} (${options})` : p.product_name, sku: p.sku,
      };
    }),
  }));
}

export function listPriceLists(ctx: TenantContext): Promise<PriceListView[]> {
  return withTenant(ctx, (tx) => selectPriceLists(tx, ctx.accountId, null));
}

async function writePrices(tx: TenantTransaction, accountId: string, listId: string, prices: PriceListPrice[]): Promise<void> {
  await tx.$executeRaw`DELETE FROM shop_price_list_prices WHERE account_id=${accountId}::uuid AND price_list_id=${listId}::uuid`;
  if (!prices.length) return;
  await tx.$executeRaw`INSERT INTO shop_price_list_prices(account_id,price_list_id,variant_id,min_qty,price_minor)
    SELECT ${accountId}::uuid, ${listId}::uuid, v, q, p
    FROM unnest(${prices.map((p) => p.variant_id)}::uuid[], ${prices.map((p) => p.min_qty)}::int[], ${prices.map((p) => BigInt(p.price_minor))}::bigint[]) AS t(v, q, p)`;
}

export async function createPriceList(ctx: Admin, input: PriceListInput): Promise<PriceListView> {
  return withTenant(ctx, async (tx) => {
    await lockStoreCurrencyShared(tx, ctx.accountId); // prices are in the store currency
    await capped(tx, ctx.accountId, 'shop_price_lists', PRICE_RULE_LIMITS.maxLists);
    await assertOwned(tx, ctx.accountId, 'shop_customer_groups', [input.group_id], 'group_id');
    await assertOwned(tx, ctx.accountId, 'shop_variants', input.prices.map((p) => p.variant_id), 'prices');
    const [row] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO shop_price_lists(account_id,name,group_id,active,created_by)
      VALUES(${ctx.accountId}::uuid,${input.name},${input.group_id}::uuid,${input.active},${ctx.userId}::uuid) RETURNING id::text AS id`;
    await writePrices(tx, ctx.accountId, row.id, input.prices);
    await auditStoreChange(tx, ctx, 'commerce.price_list_created', row.id, { prices: input.prices.length });
    return (await selectPriceLists(tx, ctx.accountId, row.id))[0];
  });
}

/** Replace a list and all of its prices. `expectedVersion` must be the version the admin loaded (409 conflict otherwise). */
export async function updatePriceList(ctx: Admin, listId: string, expectedVersion: unknown, input: PriceListInput): Promise<PriceListView> {
  if (!isUuid(listId)) throw new StoreError('not_found');
  const expected = version(expectedVersion);
  return withTenant(ctx, async (tx) => {
    await lockStoreCurrencyShared(tx, ctx.accountId);
    await assertOwned(tx, ctx.accountId, 'shop_customer_groups', [input.group_id], 'group_id');
    await assertOwned(tx, ctx.accountId, 'shop_variants', input.prices.map((p) => p.variant_id), 'prices');
    const changed = await tx.$executeRaw`UPDATE shop_price_lists SET name=${input.name},group_id=${input.group_id}::uuid,active=${input.active},version=version+1
      WHERE account_id=${ctx.accountId}::uuid AND id=${listId}::uuid AND version=${expected}`;
    if (!changed) throw new StoreError((await selectPriceLists(tx, ctx.accountId, listId)).length ? 'conflict' : 'not_found');
    await writePrices(tx, ctx.accountId, listId, input.prices);
    await auditStoreChange(tx, ctx, 'commerce.price_list_updated', listId, { prices: input.prices.length, active: input.active });
    return (await selectPriceLists(tx, ctx.accountId, listId))[0];
  });
}

export const deletePriceList = (ctx: Admin, listId: string) => remove(ctx, 'shop_price_lists', listId, 'commerce.price_list_deleted');

// ---------------------------------------------------------------------------
// Discount rules

export interface DiscountRuleView {
  id: string; name: string; product_id: string | null; product_name: string | null; category_id: string | null; category_name: string | null;
  group_id: string | null; group_name: string | null; kind: 'percent' | 'fixed'; value: number; combinable: boolean; active: boolean;
  starts_at: string | null; ends_at: string | null; version: number;
}
export interface DiscountRuleInput {
  name: string; product_id: string | null; category_id: string | null; group_id: string | null; kind: 'percent' | 'fixed'; value: number;
  combinable: boolean; active: boolean; starts_at: Date | null; ends_at: Date | null;
}

export function parseDiscountRule(body: unknown): DiscountRuleInput {
  const b = object(body);
  const kind = b.kind === 'percent' || b.kind === 'fixed' ? b.kind : null;
  if (!kind) throw new StoreError('invalid', { field: 'kind' });
  const product_id = optionalId(b.product_id, 'product_id'), category_id = optionalId(b.category_id, 'category_id'), group_id = optionalId(b.group_id, 'group_id');
  if (product_id && category_id) throw new StoreError('invalid', { field: 'category_id' });
  // A rule for every product and every customer is an automatic discount, not a price rule.
  if (!product_id && !category_id && !group_id) throw new StoreError('invalid', { field: 'product_id' });
  return {
    name: name(b.name), product_id, category_id, group_id, kind,
    value: kind === 'percent' ? int(b.value, 1, 10_000, 'value') : int(b.value, 1, MAX_RULE_MINOR, 'value'),
    combinable: bool(b.combinable, 'combinable'), active: bool(b.active, 'active'), ...dates(b),
  };
}

async function selectDiscountRules(tx: TenantTransaction, accountId: string, only: string | null): Promise<DiscountRuleView[]> {
  const rows = await tx.$queryRaw<(Omit<DiscountRuleView, 'value' | 'starts_at' | 'ends_at'> & { value: bigint; starts_at: Date | null; ends_at: Date | null })[]>`
    SELECT r.id::text AS id, r.name, r.product_id::text AS product_id, p.name AS product_name, r.category_id::text AS category_id,
      c.name AS category_name, r.group_id::text AS group_id, t.name AS group_name, r.kind, r.value, r.combinable, r.active, r.starts_at, r.ends_at, r.version
    FROM shop_discount_rules r
    LEFT JOIN shop_products p ON p.account_id=r.account_id AND p.id=r.product_id
    LEFT JOIN shop_categories c ON c.account_id=r.account_id AND c.id=r.category_id
    LEFT JOIN shop_customer_groups t ON t.account_id=r.account_id AND t.id=r.group_id
    WHERE r.account_id=${accountId}::uuid AND (${only}::uuid IS NULL OR r.id=${only}::uuid)
    ORDER BY r.created_at, r.id LIMIT ${PRICE_RULE_LIMITS.maxRules}`;
  return rows.map((r) => ({ ...r, value: minorFromDb(r.value) ?? 0, starts_at: r.starts_at?.toISOString() ?? null, ends_at: r.ends_at?.toISOString() ?? null }));
}

export function listDiscountRules(ctx: TenantContext): Promise<DiscountRuleView[]> {
  return withTenant(ctx, (tx) => selectDiscountRules(tx, ctx.accountId, null));
}

async function assertRuleTargets(tx: TenantTransaction, accountId: string, input: DiscountRuleInput): Promise<void> {
  await assertOwned(tx, accountId, 'shop_products', [input.product_id], 'product_id');
  await assertOwned(tx, accountId, 'shop_categories', [input.category_id], 'category_id');
  await assertOwned(tx, accountId, 'shop_customer_groups', [input.group_id], 'group_id');
}

export async function createDiscountRule(ctx: Admin, input: DiscountRuleInput): Promise<DiscountRuleView> {
  return withTenant(ctx, async (tx) => {
    await lockStoreCurrencyShared(tx, ctx.accountId);
    await capped(tx, ctx.accountId, 'shop_discount_rules', PRICE_RULE_LIMITS.maxRules);
    await assertRuleTargets(tx, ctx.accountId, input);
    const [row] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO shop_discount_rules(account_id,name,product_id,category_id,group_id,kind,value,
        combinable,active,starts_at,ends_at,created_by)
      VALUES(${ctx.accountId}::uuid,${input.name},${input.product_id}::uuid,${input.category_id}::uuid,${input.group_id}::uuid,${input.kind},
        ${input.value},${input.combinable},${input.active},${input.starts_at},${input.ends_at},${ctx.userId}::uuid)
      RETURNING id::text AS id`;
    await auditStoreChange(tx, ctx, 'commerce.discount_rule_created', row.id, { kind: input.kind, combinable: input.combinable });
    return (await selectDiscountRules(tx, ctx.accountId, row.id))[0];
  });
}

export async function updateDiscountRule(ctx: Admin, ruleId: string, expectedVersion: unknown, input: DiscountRuleInput): Promise<DiscountRuleView> {
  if (!isUuid(ruleId)) throw new StoreError('not_found');
  const expected = version(expectedVersion);
  return withTenant(ctx, async (tx) => {
    await lockStoreCurrencyShared(tx, ctx.accountId);
    await assertRuleTargets(tx, ctx.accountId, input);
    const changed = await tx.$executeRaw`UPDATE shop_discount_rules SET name=${input.name},product_id=${input.product_id}::uuid,
        category_id=${input.category_id}::uuid,group_id=${input.group_id}::uuid,kind=${input.kind},value=${input.value},combinable=${input.combinable},
        active=${input.active},starts_at=${input.starts_at},ends_at=${input.ends_at},version=version+1
      WHERE account_id=${ctx.accountId}::uuid AND id=${ruleId}::uuid AND version=${expected}`;
    if (!changed) throw new StoreError((await selectDiscountRules(tx, ctx.accountId, ruleId)).length ? 'conflict' : 'not_found');
    await auditStoreChange(tx, ctx, 'commerce.discount_rule_updated', ruleId, { kind: input.kind, combinable: input.combinable, active: input.active });
    return (await selectDiscountRules(tx, ctx.accountId, ruleId))[0];
  });
}

export const deleteDiscountRule = (ctx: Admin, ruleId: string) => remove(ctx, 'shop_discount_rules', ruleId, 'commerce.discount_rule_deleted');

// ---------------------------------------------------------------------------
// Gift rules

export interface GiftRuleView {
  id: string; name: string; min_subtotal_minor: number | null; trigger_product_id: string | null; trigger_product_name: string | null;
  gift_variant_id: string; gift_name: string | null; active: boolean; starts_at: string | null; ends_at: string | null; version: number;
}
export interface GiftRuleInput {
  name: string; min_subtotal_minor: number | null; trigger_product_id: string | null; gift_variant_id: string; active: boolean;
  starts_at: Date | null; ends_at: Date | null;
}

export function parseGiftRule(body: unknown): GiftRuleInput {
  const b = object(body);
  const trigger_product_id = optionalId(b.trigger_product_id, 'trigger_product_id');
  const min_subtotal_minor = absent(b.min_subtotal_minor) ? null : int(b.min_subtotal_minor, 1, MAX_RULE_MINOR, 'min_subtotal_minor');
  // Exactly one condition: an amount to spend, or a product to buy.
  if ((min_subtotal_minor === null) === (trigger_product_id === null)) throw new StoreError('invalid', { field: 'min_subtotal_minor' });
  return { name: name(b.name), min_subtotal_minor, trigger_product_id, gift_variant_id: id(b.gift_variant_id, 'gift_variant_id'), active: bool(b.active, 'active'), ...dates(b) };
}

async function selectGiftRules(tx: TenantTransaction, accountId: string, only: string | null): Promise<GiftRuleView[]> {
  const rows = await tx.$queryRaw<{ id: string; name: string; min_subtotal_minor: bigint | null; trigger_product_id: string | null;
    trigger_product_name: string | null; gift_variant_id: string; gift_product: string | null; gift_options: Record<string, string> | null;
    active: boolean; starts_at: Date | null; ends_at: Date | null; version: number }[]>`
    SELECT g.id::text AS id, g.name, g.min_subtotal_minor, g.trigger_product_id::text AS trigger_product_id, tp.name AS trigger_product_name,
      g.gift_variant_id::text AS gift_variant_id, gp.name AS gift_product, v.option_values AS gift_options, g.active, g.starts_at, g.ends_at, g.version
    FROM shop_gift_rules g
    LEFT JOIN shop_products tp ON tp.account_id=g.account_id AND tp.id=g.trigger_product_id
    LEFT JOIN shop_variants v ON v.account_id=g.account_id AND v.id=g.gift_variant_id
    LEFT JOIN shop_products gp ON gp.account_id=v.account_id AND gp.id=v.product_id
    WHERE g.account_id=${accountId}::uuid AND (${only}::uuid IS NULL OR g.id=${only}::uuid)
    ORDER BY g.created_at, g.id LIMIT ${PRICE_RULE_LIMITS.maxGiftRules}`;
  return rows.map((r) => {
    const options = Object.values(r.gift_options ?? {}).filter(Boolean).join(' / ');
    return {
      id: r.id, name: r.name, min_subtotal_minor: minorFromDb(r.min_subtotal_minor), trigger_product_id: r.trigger_product_id,
      trigger_product_name: r.trigger_product_name, gift_variant_id: r.gift_variant_id,
      gift_name: r.gift_product ? (options ? `${r.gift_product} (${options})` : r.gift_product) : null,
      active: r.active, starts_at: r.starts_at?.toISOString() ?? null, ends_at: r.ends_at?.toISOString() ?? null, version: r.version,
    };
  });
}

export function listGiftRules(ctx: TenantContext): Promise<GiftRuleView[]> {
  return withTenant(ctx, (tx) => selectGiftRules(tx, ctx.accountId, null));
}

async function assertGiftTargets(tx: TenantTransaction, accountId: string, input: GiftRuleInput): Promise<void> {
  await assertOwned(tx, accountId, 'shop_products', [input.trigger_product_id], 'trigger_product_id');
  await assertOwned(tx, accountId, 'shop_variants', [input.gift_variant_id], 'gift_variant_id');
}

export async function createGiftRule(ctx: Admin, input: GiftRuleInput): Promise<GiftRuleView> {
  return withTenant(ctx, async (tx) => {
    await lockStoreCurrencyShared(tx, ctx.accountId);
    await capped(tx, ctx.accountId, 'shop_gift_rules', PRICE_RULE_LIMITS.maxGiftRules);
    await assertGiftTargets(tx, ctx.accountId, input);
    const [row] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO shop_gift_rules(account_id,name,min_subtotal_minor,trigger_product_id,
        gift_variant_id,active,starts_at,ends_at,created_by)
      VALUES(${ctx.accountId}::uuid,${input.name},${input.min_subtotal_minor},${input.trigger_product_id}::uuid,${input.gift_variant_id}::uuid,
        ${input.active},${input.starts_at},${input.ends_at},${ctx.userId}::uuid)
      RETURNING id::text AS id`;
    await auditStoreChange(tx, ctx, 'commerce.gift_rule_created', row.id);
    return (await selectGiftRules(tx, ctx.accountId, row.id))[0];
  });
}

export async function updateGiftRule(ctx: Admin, ruleId: string, expectedVersion: unknown, input: GiftRuleInput): Promise<GiftRuleView> {
  if (!isUuid(ruleId)) throw new StoreError('not_found');
  const expected = version(expectedVersion);
  return withTenant(ctx, async (tx) => {
    await lockStoreCurrencyShared(tx, ctx.accountId);
    await assertGiftTargets(tx, ctx.accountId, input);
    const changed = await tx.$executeRaw`UPDATE shop_gift_rules SET name=${input.name},min_subtotal_minor=${input.min_subtotal_minor},
        trigger_product_id=${input.trigger_product_id}::uuid,gift_variant_id=${input.gift_variant_id}::uuid,active=${input.active},
        starts_at=${input.starts_at},ends_at=${input.ends_at},version=version+1
      WHERE account_id=${ctx.accountId}::uuid AND id=${ruleId}::uuid AND version=${expected}`;
    if (!changed) throw new StoreError((await selectGiftRules(tx, ctx.accountId, ruleId)).length ? 'conflict' : 'not_found');
    await auditStoreChange(tx, ctx, 'commerce.gift_rule_updated', ruleId, { active: input.active });
    return (await selectGiftRules(tx, ctx.accountId, ruleId))[0];
  });
}

export const deleteGiftRule = (ctx: Admin, ruleId: string) => remove(ctx, 'shop_gift_rules', ruleId, 'commerce.gift_rule_deleted');
