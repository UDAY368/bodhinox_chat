/**
 * "Check delivery" on the product page (store plan Phase 5). Anonymous and
 * read-only: one pincode and one variant in, "deliverable, shipping fee, cash
 * on delivery" out, worked out on the server from this workspace's own active
 * shipping rates. An estimate for one unit-count of this item alone; the
 * checkout total can differ (coupons, automatic discounts, other items). The
 * pincode is never stored or logged.
 */
import { hasStateOnlyRate, parsePincode } from './pincode';
import { quoteShippingForPincode } from './pricing';
import { minorFromDb } from './money';
import { withPublicShop } from './public-shop';
import { isUuid, loadPricingSettings, pricingRate, selectRates } from './store-settings';

export interface PincodeCheckResult {
  deliverable: boolean;
  /** No prefix or catch-all rate matched but a state-only rate exists: only the checkout address can tell. `deliverable` is false then. */
  unknown: boolean;
  /** Shipping for this one item in minor units; 0 with `deliverable` true means free. */
  shippingMinor: number;
  currency: string | null;
  /** Zone allows COD, the store accepts COD and the product allows it. */
  cod: boolean;
}

export async function checkDelivery(handle: string, input: Record<string, unknown>): Promise<PincodeCheckResult | null> {
  const pincode = parsePincode(input.pincode);
  const quantity = typeof input.quantity === 'number' && Number.isInteger(input.quantity) && input.quantity >= 1 && input.quantity <= 100 ? input.quantity : 1;
  if (!pincode || !isUuid(input.variantId)) return null;
  const variantId = input.variantId;
  return withPublicShop(handle, async (tx, accountId) => {
    const [variant] = await tx.$queryRaw<{ price_minor: bigint; weight_grams: number | null; cod_available: boolean }[]>`
      SELECT v.price_minor, v.weight_grams, p.cod_available FROM shop_variants v
      JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id AND p.status='published'
      WHERE v.account_id=${accountId}::uuid AND v.id=${variantId}::uuid AND v.archived_at IS NULL AND v.price_minor IS NOT NULL`;
    if (!variant) return null;
    const settings = await loadPricingSettings(tx, accountId);
    const rates = (await selectRates(tx, accountId, true)).map(pricingRate);
    const quote = quoteShippingForPincode(rates, {
      pincode, weightGrams: (variant.weight_grams ?? 0) * quantity, subtotalMinor: (minorFromDb(variant.price_minor) ?? 0) * quantity,
    });
    return {
      deliverable: quote.deliverable, unknown: !quote.deliverable && hasStateOnlyRate(rates), shippingMinor: quote.priceMinor, currency: settings?.currency ?? null,
      cod: quote.deliverable && quote.cod && settings?.codEnabled === true && variant.cod_available,
    };
  });
}
