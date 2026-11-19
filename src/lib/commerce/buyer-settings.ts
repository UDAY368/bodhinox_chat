/**
 * The shop's buyer self-service settings (store plan Phase 8, batch 5): whether buyers may request returns from their order
 * page, whether wishlist buyers get a price-drop nudge, and the checkout extras on offer (checkout-extras.ts). One row per
 * workspace, written by admins only (RLS and the route both check); everyone in the workspace can read it, and the public
 * pages read it through the worker inside the buyer's own workspace. Defaults: everything off.
 */
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { DEFAULT_EXTRAS_CONFIG, FALLBACK_TIMEZONE, parseExtrasConfig, type CustomField, type DeliverySlot, type ExtrasConfig } from './checkout-extras';
import { auditStoreChange, StoreError } from './store-settings';

export interface BuyerSettings extends ExtrasConfig {
  buyer_returns_enabled: boolean;
  price_drop_nudges_enabled: boolean;
}

export const DEFAULT_BUYER_SETTINGS: BuyerSettings = { ...DEFAULT_EXTRAS_CONFIG, buyer_returns_enabled: false, price_drop_nudges_enabled: false };

interface Row {
  buyer_returns_enabled: boolean; price_drop_nudges_enabled: boolean; note_enabled: boolean; gift_message_enabled: boolean;
  delivery_date_enabled: boolean; lead_days: number; window_days: number; slots: unknown; custom_fields: unknown;
}

const COLUMNS = `buyer_returns_enabled, price_drop_nudges_enabled, note_enabled, gift_message_enabled, delivery_date_enabled,
  lead_days, window_days, slots, custom_fields`;

/** The stored JSON read back through the same validator that wrote it; anything that no longer passes reads as "none". */
function fromRow(row: Row): BuyerSettings {
  let config: ExtrasConfig;
  try {
    config = parseExtrasConfig({ ...row, slots: row.slots, custom_fields: row.custom_fields });
  } catch {
    config = { ...DEFAULT_EXTRAS_CONFIG, note_enabled: row.note_enabled, gift_message_enabled: row.gift_message_enabled };
  }
  return { ...config, buyer_returns_enabled: row.buyer_returns_enabled, price_drop_nudges_enabled: row.price_drop_nudges_enabled };
}

export async function loadBuyerSettingsTx(tx: TenantTransaction, accountId: string): Promise<BuyerSettings> {
  const rows = await tx.$queryRawUnsafe<Row[]>(`SELECT ${COLUMNS} FROM shop_buyer_settings WHERE account_id=$1::uuid`, accountId);
  const base = rows[0] ? fromRow(rows[0]) : DEFAULT_BUYER_SETTINGS;
  // The workspace's own timezone (inbox settings); only a workspace with no such row falls back to India time.
  const [zone] = await tx.$queryRaw<{ timezone: string }[]>`SELECT timezone FROM workspace_inbox_settings WHERE account_id=${accountId}::uuid`;
  return { ...base, timezone: zone?.timezone ?? FALLBACK_TIMEZONE };
}

export function getBuyerSettings(ctx: TenantContext): Promise<BuyerSettings> {
  return withTenant(ctx, (tx) => loadBuyerSettingsTx(tx, ctx.accountId));
}

/** Validate an admin's body (a full replacement). */
export function parseBuyerSettings(body: unknown): BuyerSettings {
  const config = parseExtrasConfig(body);
  const b = body as Record<string, unknown>;
  if (typeof b.buyer_returns_enabled !== 'boolean') throw new StoreError('invalid', { field: 'buyer_returns_enabled' });
  if (typeof b.price_drop_nudges_enabled !== 'boolean') throw new StoreError('invalid', { field: 'price_drop_nudges_enabled' });
  return { ...config, buyer_returns_enabled: b.buyer_returns_enabled, price_drop_nudges_enabled: b.price_drop_nudges_enabled };
}

export async function saveBuyerSettings(ctx: TenantContext & { userId: string }, input: BuyerSettings): Promise<BuyerSettings> {
  return withTenant(ctx, async (tx) => {
    const slots: DeliverySlot[] = input.slots;
    const fields: CustomField[] = input.custom_fields;
    await tx.$executeRaw`INSERT INTO shop_buyer_settings(account_id,buyer_returns_enabled,price_drop_nudges_enabled,note_enabled,gift_message_enabled,
        delivery_date_enabled,lead_days,window_days,slots,custom_fields)
      VALUES(${ctx.accountId}::uuid,${input.buyer_returns_enabled},${input.price_drop_nudges_enabled},${input.note_enabled},${input.gift_message_enabled},
        ${input.delivery_date_enabled},${input.lead_days},${input.window_days},${JSON.stringify(slots)}::jsonb,${JSON.stringify(fields)}::jsonb)
      ON CONFLICT (account_id) DO UPDATE SET buyer_returns_enabled=EXCLUDED.buyer_returns_enabled,
        price_drop_nudges_enabled=EXCLUDED.price_drop_nudges_enabled,note_enabled=EXCLUDED.note_enabled,
        gift_message_enabled=EXCLUDED.gift_message_enabled,delivery_date_enabled=EXCLUDED.delivery_date_enabled,
        lead_days=EXCLUDED.lead_days,window_days=EXCLUDED.window_days,slots=EXCLUDED.slots,custom_fields=EXCLUDED.custom_fields`;
    // Field names only: the labels are the seller's own words but stay out of the audit trail.
    await auditStoreChange(tx, ctx, 'commerce.buyer_settings_updated', ctx.accountId, {
      returns: input.buyer_returns_enabled, nudges: input.price_drop_nudges_enabled, slots: slots.length, custom_fields: fields.length,
    });
    return loadBuyerSettingsTx(tx, ctx.accountId);
  });
}
