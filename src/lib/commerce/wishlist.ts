/**
 * The wishlist (store plan Phase 8, batch 5). A buyer saves variants; the buyer is the contact the shop session identifies
 * (the WhatsApp code or the shop link), so a wishlist belongs to a known contact. An anonymous visitor keeps theirs in their own
 * browser (components/shop-public/wishlist-store.ts) and it is saved here, once, when they come in through a session. At most 50
 * saved variants per contact; saving the same variant twice is one row. The price-drop nudge is in price-drop-jobs.ts.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { isUuid, StoreError } from './store-settings';
import { loadVariants } from './storefront';
import { WISHLIST_MAX } from './price-drops';

export interface WishlistEntry {
  variantId: string;
  productId: string;
  name: string;
  options: string;
  priceMinor: number | null;
  /** Can be bought now. */
  available: boolean;
}

export interface Wishlist { currency: string | null; items: WishlistEntry[] }

/** Up to 50 distinct variant ids from a browser's saved list; anything else is dropped. */
export function parseVariantIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new StoreError('invalid', { field: 'variantIds' });
  return [...new Set(value.filter(isUuid).map((v) => v.toLowerCase()))].slice(0, WISHLIST_MAX);
}

export async function listWishlistTx(tx: TenantTransaction, accountId: string, contactId: string): Promise<Wishlist> {
  const rows = await tx.$queryRaw<{ variant_id: string; product_id: string; name: string; option_values: Record<string, string> | null;
    price_minor: bigint | null; sellable: boolean }[]>`
    SELECT w.variant_id::text AS variant_id, p.id::text AS product_id, p.name, v.option_values, v.price_minor,
      (shop_product_live(p.status, p.publish_at, p.hide_at) AND v.archived_at IS NULL AND v.price_minor IS NOT NULL
        AND COALESCE(shop_variant_availability(v.account_id, v.id), 1) > 0) AS sellable
    FROM shop_wishlist_items w
    JOIN shop_variants v ON v.account_id=w.account_id AND v.id=w.variant_id
    JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
    WHERE w.account_id=${accountId}::uuid AND w.contact_id=${contactId}::uuid ORDER BY w.created_at DESC LIMIT ${WISHLIST_MAX}`;
  const [settings] = await tx.$queryRaw<{ currency: string | null }[]>`SELECT currency FROM commerce_settings WHERE account_id=${accountId}::uuid`;
  return {
    currency: settings?.currency ?? null,
    items: rows.map((r) => ({
      variantId: r.variant_id, productId: r.product_id, name: r.name, options: Object.values(r.option_values ?? {}).filter(Boolean).join(', '),
      priceMinor: r.price_minor === null ? null : Number(r.price_minor), available: r.sellable,
    })),
  };
}

/**
 * Save variants for the contact (idempotent). Each must be on sale in this shop now (variant_unavailable otherwise, or skipped when
 * lenient); past
 * the cap of 50 the call is refused (wishlist_full). Checked under a per-contact lock so two calls at once cannot pass the cap.
 */
export async function addToWishlistTx(tx: TenantTransaction, accountId: string, contactId: string, ids: string[], options: { lenient?: boolean } = {}): Promise<void> {
  if (!ids.length) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wishlist:${accountId}:${contactId}`}, 0))`;
  const variants = await loadVariants(tx, accountId, ids);
  const onSale = (id: string) => { const v = variants.get(id); return !!v && v.sellable && v.priceMinor !== null; };
  // A saved list from a browser may hold variants that went off sale: those are skipped, not an error.
  const variantIds = options.lenient ? ids.filter(onSale) : ids;
  for (const id of variantIds) if (!onSale(id)) throw new StoreError('variant_unavailable', { variantId: id });
  if (!variantIds.length) return;
  const [held] = await tx.$queryRaw<{ n: number; fresh: number }[]>`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE variant_id = ANY(${variantIds}::uuid[]))::int AS fresh
    FROM shop_wishlist_items WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid`;
  if ((held?.n ?? 0) - (held?.fresh ?? 0) + variantIds.length > WISHLIST_MAX) throw new StoreError('wishlist_full');
  await tx.$executeRaw`INSERT INTO shop_wishlist_items(account_id, contact_id, variant_id)
    SELECT ${accountId}::uuid, ${contactId}::uuid, v FROM unnest(${variantIds}::uuid[]) AS v
    ON CONFLICT (account_id, contact_id, variant_id) DO NOTHING`;
}

export async function removeFromWishlistTx(tx: TenantTransaction, accountId: string, contactId: string, variantId: string): Promise<void> {
  if (!isUuid(variantId)) throw new StoreError('invalid', { field: 'variantId' });
  await tx.$executeRaw`DELETE FROM shop_wishlist_items WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid AND variant_id=${variantId}::uuid`;
}
