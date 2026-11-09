/**
 * Store settings and shipping rates (design §1 commerce_settings,
 * shipping_rates; §6 Store settings). Browser routes call these with the
 * caller's live session (withTenant, app role): agents read, admins write
 * (RLS and the column grants enforce the same rule). Every change is audited
 * with ids and field names only.
 *
 * The store currency cannot change once any variant has a price (E4).
 */
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { validateGstin } from '@/lib/billing/gst';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { queueCatalogPush } from './catalog-push';
import { isCurrencyCode, MAX_MINOR, minorFromDb } from './money';
import type { PricingSettings, PricingShippingRate } from './pricing';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export type StoreErrorCode =
  | 'invalid' | 'not_found' | 'conflict' | 'currency_locked' | 'invalid_gstin' | 'store_not_configured'
  | 'checkout_disabled' | 'feature_unavailable' | 'coupon_code_taken'
  | 'cart_locked' | 'address_required' | 'quote_changed' | 'out_of_stock' | 'coupon_exhausted' | 'coupon_limit_reached'
  | 'order_not_open' | 'no_order' | 'contact_not_found' | 'contact_blocked' | 'outside_window' | 'number_unavailable'
  | 'send_failed' | 'send_uncertain' | 'session_expired'
  | 'cart_empty' | 'invalid_cart' | 'variant_unavailable' | 'price_not_configured' | 'tax_not_configured' | 'shipping_unavailable'
  | 'coupon_not_found' | 'coupon_inactive' | 'coupon_not_started' | 'coupon_expired' | 'coupon_min_subtotal' | 'amount_out_of_range'
  | 'too_many_open_orders' | 'cod_unavailable' | 'online_unavailable';

const STATUS: Partial<Record<StoreErrorCode, number>> = {
  not_found: 404, no_order: 404, contact_not_found: 404, conflict: 409, currency_locked: 409, coupon_code_taken: 409,
  quote_changed: 409, out_of_stock: 409, cart_locked: 409, order_not_open: 409, coupon_exhausted: 409, coupon_limit_reached: 409,
  checkout_disabled: 409, store_not_configured: 409, feature_unavailable: 403, contact_blocked: 409, outside_window: 409,
  number_unavailable: 409, too_many_open_orders: 409, cod_unavailable: 409, online_unavailable: 409, send_failed: 502, send_uncertain: 502, session_expired: 410,
};

export class StoreError extends Error {
  readonly status: number;
  constructor(readonly code: StoreErrorCode, readonly detail?: Record<string, unknown>) {
    super(getT('Commerce.settings.errors')(code));
    this.name = 'StoreError';
    this.status = STATUS[code] ?? 400;
  }
}

export function storeErrorResponse(error: unknown): NextResponse {
  if (error instanceof StoreError)
    return NextResponse.json({ error: error.message, code: error.code, ...(error.detail ?? {}) }, { status: error.status });
  return toErrorResponse(error);
}

// ---------------------------------------------------------------------------
// Settings

export interface StoreSettings {
  configured: boolean;
  currency: string | null;
  prices_include_tax: boolean;
  default_tax_rate_bps: number | null;
  reservation_minutes: number;
  checkout_enabled: boolean;
  low_stock_default: number;
  legal_name: string | null;
  gstin: string | null;
  address: string | null;
  state_code: string | null;
  document_prefix: string;
  storefront_title: string | null;
  return_window_days: number;
  checkout_template_name: string | null;
  checkout_template_language: string | null;
  /** Cash on delivery offered at checkout (only for carts whose products all allow it). */
  cod_enabled: boolean;
  /** Fixed fee added to a COD order, in the store currency's minor units (0 = none). */
  cod_fee_minor: number;
  /** True once any variant is priced: the currency can no longer change. */
  currency_locked: boolean;
  /** Razorpay is connected, so the storefront can offer online payment (read-only here). */
  online_payment_ready: boolean;
}

const DEFAULTS: Omit<StoreSettings, 'configured' | 'currency_locked' | 'online_payment_ready'> = {
  currency: null, prices_include_tax: true, default_tax_rate_bps: null, reservation_minutes: 15, checkout_enabled: false,
  low_stock_default: 5, legal_name: null, gstin: null, address: null, state_code: null, document_prefix: 'RCPT',
  storefront_title: null, return_window_days: 7, checkout_template_name: null, checkout_template_language: null,
  cod_enabled: false, cod_fee_minor: 0,
};

type SettingsRow = Omit<StoreSettings, 'configured' | 'currency_locked' | 'online_payment_ready'>;
type RawSettingsRow = Omit<SettingsRow, 'cod_fee_minor'> & { cod_fee_minor: bigint | number };

export async function loadSettingsRow(tx: TenantTransaction, accountId: string, lock = false): Promise<SettingsRow | null> {
  const rows = lock
    ? await tx.$queryRaw<RawSettingsRow[]>`SELECT currency, prices_include_tax, default_tax_rate_bps, reservation_minutes, checkout_enabled,
        low_stock_default, legal_name, gstin, address, state_code, document_prefix, storefront_title, return_window_days,
        checkout_template_name, checkout_template_language, cod_enabled, cod_fee_minor
      FROM commerce_settings WHERE account_id=${accountId}::uuid FOR UPDATE`
    : await tx.$queryRaw<RawSettingsRow[]>`SELECT currency, prices_include_tax, default_tax_rate_bps, reservation_minutes, checkout_enabled,
        low_stock_default, legal_name, gstin, address, state_code, document_prefix, storefront_title, return_window_days,
        checkout_template_name, checkout_template_language, cod_enabled, cod_fee_minor
      FROM commerce_settings WHERE account_id=${accountId}::uuid`;
  const row = rows[0];
  return row ? { ...row, cod_fee_minor: minorFromDb(row.cod_fee_minor) ?? 0 } : null;
}

/** The settings pricing needs, or null when the store has never been configured. */
export async function loadPricingSettings(tx: TenantTransaction, accountId: string): Promise<(PricingSettings & SettingsRow) | null> {
  const row = await loadSettingsRow(tx, accountId);
  if (!row?.currency) return null;
  return {
    ...row, currency: row.currency, pricesIncludeTax: row.prices_include_tax, defaultTaxRateBps: row.default_tax_rate_bps,
    codEnabled: row.cod_enabled, codFeeMinor: row.cod_fee_minor,
  };
}

/**
 * True once any stored amount is denominated in the store currency: a variant price, a shipping rate (fee and subtotal
 * bands), a fixed-value coupon or a coupon minimum/cap, a COD fee, or a priced order. Changing the currency would silently
 * re-denominate those minor units (100x between INR and JPY), so the currency is then locked.
 */
/** Whether a checkout payment link can be made: the workspace has a Razorpay connection. */
export async function onlinePaymentReady(tx: TenantTransaction, accountId: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT EXISTS(SELECT 1 FROM payment_providers
    WHERE account_id=${accountId}::uuid AND provider='razorpay') AS ok`;
  return Boolean(row?.ok);
}

export async function currencyInUse(tx: TenantTransaction, accountId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ used: boolean }[]>`SELECT
      EXISTS (SELECT 1 FROM shop_variants WHERE account_id=${accountId}::uuid AND price_minor IS NOT NULL)
      OR EXISTS (SELECT 1 FROM shipping_rates WHERE account_id=${accountId}::uuid)
      OR EXISTS (SELECT 1 FROM coupons WHERE account_id=${accountId}::uuid
        AND (kind='fixed' OR min_subtotal_minor > 0 OR max_discount_minor IS NOT NULL))
      OR EXISTS (SELECT 1 FROM commerce_settings WHERE account_id=${accountId}::uuid AND cod_fee_minor > 0)
      OR EXISTS (SELECT 1 FROM orders WHERE account_id=${accountId}::uuid AND priced_at IS NOT NULL) AS used`;
  return rows[0]?.used === true;
}

/**
 * Hold the settings row (shared) while writing an amount in the store currency, so a concurrent currency change
 * (which takes it FOR UPDATE and then checks currencyInUse) either commits first or sees this row.
 */
export async function lockStoreCurrencyShared(tx: TenantTransaction, accountId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM commerce_settings WHERE account_id=${accountId}::uuid FOR SHARE`;
}

export async function getStoreSettings(ctx: TenantContext): Promise<StoreSettings> {
  return withTenant(ctx, async (tx) => {
    const row = await loadSettingsRow(tx, ctx.accountId);
    return { ...DEFAULTS, ...(row ?? {}), configured: !!row, currency_locked: await currencyInUse(tx, ctx.accountId),
      online_payment_ready: await onlinePaymentReady(tx, ctx.accountId) };
  });
}

/** cod_enabled and cod_fee_minor are optional: a client that does not send them keeps the stored values. */
export type StoreSettingsInput = Omit<StoreSettings, 'configured' | 'currency_locked' | 'online_payment_ready' | 'currency' | 'cod_enabled' | 'cod_fee_minor'>
  & { currency: string; cod_enabled?: boolean; cod_fee_minor?: number };

const optText = (value: unknown, max: number): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new StoreError('invalid', { field: 'text' });
  const trimmed = value.trim();
  if (trimmed.length > max) throw new StoreError('invalid', { field: 'text' });
  return trimmed || null;
};
const int = (value: unknown, min: number, max: number, field: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new StoreError('invalid', { field });
  return value;
};

/** Validate a settings body (a full replacement). */
export function parseStoreSettings(body: unknown): StoreSettingsInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  if (!isCurrencyCode(b.currency)) throw new StoreError('invalid', { field: 'currency' });
  if (typeof b.prices_include_tax !== 'boolean' || typeof b.checkout_enabled !== 'boolean') throw new StoreError('invalid', { field: 'flags' });
  const gstinRaw = optText(b.gstin, 15);
  const gstin = gstinRaw ? validateGstin(gstinRaw) : null;
  if (gstinRaw && !gstin) throw new StoreError('invalid_gstin');
  const stateCode = optText(b.state_code, 2)?.toUpperCase() ?? null;
  if (stateCode && !/^[0-9A-Z]{2}$/.test(stateCode)) throw new StoreError('invalid', { field: 'state_code' });
  const prefix = typeof b.document_prefix === 'string' ? b.document_prefix.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{1,8}$/.test(prefix)) throw new StoreError('invalid', { field: 'document_prefix' });
  const templateName = optText(b.checkout_template_name, 512);
  const templateLanguage = templateName ? optText(b.checkout_template_language, 15) : null;
  if (b.cod_enabled !== undefined && typeof b.cod_enabled !== 'boolean') throw new StoreError('invalid', { field: 'cod_enabled' });
  const codFee = b.cod_fee_minor === undefined ? undefined : int(b.cod_fee_minor, 0, MAX_MINOR, 'cod_fee_minor');
  return {
    currency: b.currency,
    prices_include_tax: b.prices_include_tax,
    default_tax_rate_bps: b.default_tax_rate_bps === null || b.default_tax_rate_bps === undefined ? null : int(b.default_tax_rate_bps, 0, 10000, 'default_tax_rate_bps'),
    reservation_minutes: int(b.reservation_minutes, 15, 60, 'reservation_minutes'),
    checkout_enabled: b.checkout_enabled,
    low_stock_default: int(b.low_stock_default, 0, 100000, 'low_stock_default'),
    legal_name: optText(b.legal_name, 200),
    gstin,
    address: optText(b.address, 500),
    state_code: stateCode,
    document_prefix: prefix,
    storefront_title: optText(b.storefront_title, 120),
    return_window_days: int(b.return_window_days, 0, 90, 'return_window_days'),
    checkout_template_name: templateName,
    checkout_template_language: templateLanguage,
    ...(b.cod_enabled === undefined ? {} : { cod_enabled: b.cod_enabled }),
    ...(codFee === undefined ? {} : { cod_fee_minor: codFee }),
  };
}

export async function saveStoreSettings(ctx: TenantContext & { userId: string }, input: StoreSettingsInput): Promise<StoreSettings> {
  return withTenant(ctx, async (tx) => {
    const current = await loadSettingsRow(tx, ctx.accountId, true);
    const locked = await currencyInUse(tx, ctx.accountId);
    if (locked && current?.currency && current.currency !== input.currency) throw new StoreError('currency_locked');
    const codEnabled = input.cod_enabled ?? current?.cod_enabled ?? false;
    const codFeeMinor = input.cod_fee_minor ?? current?.cod_fee_minor ?? 0;
    // The fee is taxed at the store default rate: without one every COD quote would be refused.
    if (codEnabled && codFeeMinor > 0 && input.default_tax_rate_bps === null)
      throw new StoreError('tax_not_configured', { field: 'default_tax_rate_bps' });
    await tx.$executeRaw`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,reservation_minutes,
        checkout_enabled,low_stock_default,legal_name,gstin,address,state_code,document_prefix,storefront_title,return_window_days,
        checkout_template_name,checkout_template_language,cod_enabled,cod_fee_minor)
      VALUES(${ctx.accountId}::uuid,${input.currency},${input.prices_include_tax},${input.default_tax_rate_bps},${input.reservation_minutes},
        ${input.checkout_enabled},${input.low_stock_default},${input.legal_name},${input.gstin},${input.address},${input.state_code},
        ${input.document_prefix},${input.storefront_title},${input.return_window_days},${input.checkout_template_name},
        ${input.checkout_template_language},${codEnabled},${codFeeMinor})
      ON CONFLICT (account_id) DO UPDATE SET currency=EXCLUDED.currency,prices_include_tax=EXCLUDED.prices_include_tax,
        default_tax_rate_bps=EXCLUDED.default_tax_rate_bps,reservation_minutes=EXCLUDED.reservation_minutes,
        checkout_enabled=EXCLUDED.checkout_enabled,low_stock_default=EXCLUDED.low_stock_default,legal_name=EXCLUDED.legal_name,
        gstin=EXCLUDED.gstin,address=EXCLUDED.address,state_code=EXCLUDED.state_code,document_prefix=EXCLUDED.document_prefix,
        storefront_title=EXCLUDED.storefront_title,return_window_days=EXCLUDED.return_window_days,
        checkout_template_name=EXCLUDED.checkout_template_name,checkout_template_language=EXCLUDED.checkout_template_language,
        cod_enabled=EXCLUDED.cod_enabled,cod_fee_minor=EXCLUDED.cod_fee_minor`;
    const changed = Object.keys(input).filter((k) => !current || current[k as keyof SettingsRow] !== input[k as keyof StoreSettingsInput]);
    // Checkout turned on (Bodhinox becomes the seller of record) or the store currency changed: push linked
    // variants' price and availability to the Meta catalogue (audit finding 20). Same transaction, ids only.
    if (input.checkout_enabled && (!current?.checkout_enabled || current.currency !== input.currency))
      await queueCatalogPush(ctx.accountId, tx);
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${ctx.accountId}::uuid,${ctx.userId}::uuid,'commerce.settings_updated',${ctx.accountId},${JSON.stringify({ fields: changed })}::jsonb)`;
    const row = await loadSettingsRow(tx, ctx.accountId);
    return { ...DEFAULTS, ...(row ?? {}), configured: true, currency_locked: locked, online_payment_ready: await onlinePaymentReady(tx, ctx.accountId) };
  });
}

// ---------------------------------------------------------------------------
// Shipping rates

export interface ShippingRateView {
  id: string;
  name: string;
  country: string;
  postal_prefixes: string[];
  min_subtotal_minor: number;
  max_subtotal_minor: number | null;
  fee_minor: number;
  tax_rate_bps: number | null;
  active: boolean;
  position: number;
}

interface RateRow {
  id: string; name: string; country: string; postal_prefixes: string[]; min_subtotal_minor: bigint; max_subtotal_minor: bigint | null;
  fee_minor: bigint; tax_rate_bps: number | null; active: boolean; position: number;
}

const toRate = (r: RateRow): ShippingRateView => ({
  id: r.id, name: r.name, country: r.country, postal_prefixes: r.postal_prefixes, min_subtotal_minor: minorFromDb(r.min_subtotal_minor) ?? 0,
  max_subtotal_minor: minorFromDb(r.max_subtotal_minor), fee_minor: minorFromDb(r.fee_minor) ?? 0, tax_rate_bps: r.tax_rate_bps,
  active: r.active, position: r.position,
});

export async function selectRates(tx: TenantTransaction, accountId: string, activeOnly: boolean): Promise<ShippingRateView[]> {
  const rows = await tx.$queryRaw<RateRow[]>`SELECT id::text AS id, name, country, postal_prefixes, min_subtotal_minor, max_subtotal_minor,
      fee_minor, tax_rate_bps, active, position FROM shipping_rates
    WHERE account_id=${accountId}::uuid AND (${!activeOnly} OR active) ORDER BY position, name LIMIT 500`;
  return rows.map(toRate);
}

export const pricingRate = (r: ShippingRateView): PricingShippingRate => ({
  id: r.id, name: r.name, country: r.country, postalPrefixes: r.postal_prefixes, minSubtotalMinor: r.min_subtotal_minor,
  maxSubtotalMinor: r.max_subtotal_minor, feeMinor: r.fee_minor, taxRateBps: r.tax_rate_bps, position: r.position,
});

export async function listShippingRates(ctx: TenantContext): Promise<ShippingRateView[]> {
  return withTenant(ctx, (tx) => selectRates(tx, ctx.accountId, false));
}

export type ShippingRateInput = Omit<ShippingRateView, 'id'>;

const money = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_MINOR) throw new StoreError('invalid', { field });
  return value;
};

export function parseShippingRate(body: unknown): ShippingRateInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 80) throw new StoreError('invalid', { field: 'name' });
  const country = typeof b.country === 'string' ? b.country.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(country)) throw new StoreError('invalid', { field: 'country' });
  const prefixes = b.postal_prefixes === undefined ? [] : b.postal_prefixes;
  if (!Array.isArray(prefixes) || prefixes.length > 200) throw new StoreError('invalid', { field: 'postal_prefixes' });
  const postal = [...new Set(prefixes.map((p) => (typeof p === 'string' ? p.trim().toUpperCase().replace(/[\s-]/g, '') : '')))];
  if (postal.some((p) => !/^[0-9A-Z]{1,6}$/.test(p))) throw new StoreError('invalid', { field: 'postal_prefixes' });
  const min = money(b.min_subtotal_minor ?? 0, 'min_subtotal_minor');
  const max = b.max_subtotal_minor === null || b.max_subtotal_minor === undefined ? null : money(b.max_subtotal_minor, 'max_subtotal_minor');
  if (max !== null && max < min) throw new StoreError('invalid', { field: 'max_subtotal_minor' });
  if (typeof b.active !== 'boolean') throw new StoreError('invalid', { field: 'active' });
  return {
    name, country, postal_prefixes: postal, min_subtotal_minor: min, max_subtotal_minor: max, fee_minor: money(b.fee_minor, 'fee_minor'),
    tax_rate_bps: b.tax_rate_bps === null || b.tax_rate_bps === undefined ? null : int(b.tax_rate_bps, 0, 10000, 'tax_rate_bps'),
    active: b.active, position: b.position === undefined ? 0 : int(b.position, 0, 10000, 'position'),
  };
}

async function audit(tx: TenantTransaction, ctx: TenantContext & { userId: string }, action: string, resourceId: string, metadata: object = {}) {
  await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${ctx.accountId}::uuid,${ctx.userId}::uuid,${action},${resourceId},${JSON.stringify(metadata)}::jsonb)`;
}
export { audit as auditStoreChange };

export async function createShippingRate(ctx: TenantContext & { userId: string }, input: ShippingRateInput): Promise<ShippingRateView> {
  return withTenant(ctx, async (tx) => {
    await lockStoreCurrencyShared(tx, ctx.accountId);
    const [row] = await tx.$queryRaw<RateRow[]>`INSERT INTO shipping_rates(account_id,name,country,postal_prefixes,min_subtotal_minor,
        max_subtotal_minor,fee_minor,tax_rate_bps,active,position)
      VALUES(${ctx.accountId}::uuid,${input.name},${input.country},${input.postal_prefixes}::text[],${input.min_subtotal_minor},
        ${input.max_subtotal_minor},${input.fee_minor},${input.tax_rate_bps},${input.active},${input.position})
      RETURNING id::text AS id, name, country, postal_prefixes, min_subtotal_minor, max_subtotal_minor, fee_minor, tax_rate_bps, active, position`;
    await audit(tx, ctx, 'commerce.shipping_rate_created', row.id);
    return toRate(row);
  });
}

export async function updateShippingRate(ctx: TenantContext & { userId: string }, id: string, input: ShippingRateInput): Promise<ShippingRateView> {
  if (!isUuid(id)) throw new StoreError('not_found');
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.$queryRaw<RateRow[]>`UPDATE shipping_rates SET name=${input.name},country=${input.country},
        postal_prefixes=${input.postal_prefixes}::text[],min_subtotal_minor=${input.min_subtotal_minor},max_subtotal_minor=${input.max_subtotal_minor},
        fee_minor=${input.fee_minor},tax_rate_bps=${input.tax_rate_bps},active=${input.active},position=${input.position}
      WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid
      RETURNING id::text AS id, name, country, postal_prefixes, min_subtotal_minor, max_subtotal_minor, fee_minor, tax_rate_bps, active, position`;
    if (!row) throw new StoreError('not_found');
    await audit(tx, ctx, 'commerce.shipping_rate_updated', id);
    return toRate(row);
  });
}

export async function deleteShippingRate(ctx: TenantContext & { userId: string }, id: string): Promise<void> {
  if (!isUuid(id)) throw new StoreError('not_found');
  await withTenant(ctx, async (tx) => {
    const removed = await tx.$executeRaw`DELETE FROM shipping_rates WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
    if (!removed) throw new StoreError('not_found');
    await audit(tx, ctx, 'commerce.shipping_rate_deleted', id);
  });
}
