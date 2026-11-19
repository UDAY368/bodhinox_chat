/**
 * Store pickup and local delivery (store plan Phase 8). One row per workspace
 * (shop_delivery_options): admins write it on the app role (RLS), the public
 * checkout reads it on the worker role inside the session's tenant.
 *
 * The buyer's choice lives on the storefront session (delivery_method) and is
 * priced only by pricing.ts priceCart, so the quote and the stored order agree.
 */
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { MAX_MINOR, minorFromDb } from './money';
import type { PricingDeliveryOptions } from './pricing';
import { auditStoreChange, loadSettingsRow, lockStoreCurrencyShared, StoreError } from './store-settings';

export interface DeliveryOptions {
  pickup_enabled: boolean;
  pickup_address: string | null;
  pickup_instructions: string | null;
  local_enabled: boolean;
  local_fee_minor: number;
  local_postal_prefixes: string[];
}

export const DELIVERY_DEFAULTS: DeliveryOptions = {
  pickup_enabled: false, pickup_address: null, pickup_instructions: null, local_enabled: false, local_fee_minor: 0, local_postal_prefixes: [],
};
export const MAX_LOCAL_PREFIXES = 200;

/** The workspace's delivery options (the defaults, everything off, when never saved). */
export async function loadDeliveryOptionsTx(tx: TenantTransaction, accountId: string): Promise<DeliveryOptions> {
  const [row] = await tx.$queryRaw<(Omit<DeliveryOptions, 'local_fee_minor'> & { local_fee_minor: bigint })[]>`
    SELECT pickup_enabled, pickup_address, pickup_instructions, local_enabled, local_fee_minor, local_postal_prefixes
    FROM shop_delivery_options WHERE account_id=${accountId}::uuid`;
  return row ? { ...row, local_fee_minor: minorFromDb(row.local_fee_minor) ?? 0 } : { ...DELIVERY_DEFAULTS };
}

export const pricingDelivery = (o: DeliveryOptions): PricingDeliveryOptions => ({
  pickupEnabled: o.pickup_enabled, localEnabled: o.local_enabled, localFeeMinor: o.local_fee_minor, localPostalPrefixes: o.local_postal_prefixes,
});

const text = (value: unknown, max: number, field: string): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new StoreError('invalid', { field });
  const v = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();
  if (v.length > max) throw new StoreError('invalid', { field });
  return v || null;
};

/** Validate a delivery options body (a full replacement). Pickup needs an address; local delivery needs at least one postal prefix. */
export function parseDeliveryOptions(body: unknown): DeliveryOptions {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  if (typeof b.pickup_enabled !== 'boolean') throw new StoreError('invalid', { field: 'pickup_enabled' });
  if (typeof b.local_enabled !== 'boolean') throw new StoreError('invalid', { field: 'local_enabled' });
  const address = text(b.pickup_address, 500, 'pickup_address');
  if (b.pickup_enabled && !address) throw new StoreError('invalid', { field: 'pickup_address' });
  const fee = b.local_fee_minor ?? 0;
  if (typeof fee !== 'number' || !Number.isSafeInteger(fee) || fee < 0 || fee > MAX_MINOR) throw new StoreError('invalid', { field: 'local_fee_minor' });
  const raw = b.local_postal_prefixes ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_LOCAL_PREFIXES) throw new StoreError('invalid', { field: 'local_postal_prefixes' });
  const prefixes = [...new Set(raw.map((p) => (typeof p === 'string' ? p.trim().toUpperCase().replace(/[\s-]/g, '') : '')))];
  if (prefixes.some((p) => !/^[0-9A-Z]{1,10}$/.test(p))) throw new StoreError('invalid', { field: 'local_postal_prefixes' });
  if (b.local_enabled && !prefixes.length) throw new StoreError('invalid', { field: 'local_postal_prefixes' });
  return {
    pickup_enabled: b.pickup_enabled, pickup_address: address, pickup_instructions: text(b.pickup_instructions, 500, 'pickup_instructions'),
    local_enabled: b.local_enabled, local_fee_minor: fee, local_postal_prefixes: prefixes,
  };
}

export function getDeliveryOptions(ctx: TenantContext): Promise<DeliveryOptions> {
  return withTenant(ctx, (tx) => loadDeliveryOptionsTx(tx, ctx.accountId));
}

/** Save the delivery options (admins; RLS refuses anyone below). Audited with the changed field names only. */
export async function saveDeliveryOptions(ctx: TenantContext & { userId: string }, input: DeliveryOptions): Promise<DeliveryOptions> {
  return withTenant(ctx, async (tx) => {
    const settings = await loadSettingsRow(tx, ctx.accountId);
    if (!settings?.currency) throw new StoreError('store_not_configured');
    // The fee is an amount in the store currency and is taxed at the store default rate (like the COD fee).
    await lockStoreCurrencyShared(tx, ctx.accountId);
    if (input.local_enabled && input.local_fee_minor > 0 && settings.default_tax_rate_bps === null)
      throw new StoreError('tax_not_configured', { field: 'default_tax_rate_bps' });
    const before = await loadDeliveryOptionsTx(tx, ctx.accountId);
    await tx.$executeRaw`INSERT INTO shop_delivery_options(account_id,pickup_enabled,pickup_address,pickup_instructions,local_enabled,
        local_fee_minor,local_postal_prefixes)
      VALUES(${ctx.accountId}::uuid,${input.pickup_enabled},${input.pickup_address},${input.pickup_instructions},${input.local_enabled},
        ${input.local_fee_minor},${input.local_postal_prefixes}::text[])
      ON CONFLICT (account_id) DO UPDATE SET pickup_enabled=EXCLUDED.pickup_enabled,pickup_address=EXCLUDED.pickup_address,
        pickup_instructions=EXCLUDED.pickup_instructions,local_enabled=EXCLUDED.local_enabled,local_fee_minor=EXCLUDED.local_fee_minor,
        local_postal_prefixes=EXCLUDED.local_postal_prefixes`;
    const changed = (Object.keys(input) as Array<keyof DeliveryOptions>).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(input[k]));
    await auditStoreChange(tx, ctx, 'commerce.delivery_options_updated', ctx.accountId, { fields: changed });
    return loadDeliveryOptionsTx(tx, ctx.accountId);
  });
}
