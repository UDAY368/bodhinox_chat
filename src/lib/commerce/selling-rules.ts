/**
 * Pure rules for the store's selling options (store plan Phase 8, batch 3): scheduled publish and hide,
 * pre-orders and bundles. No database and no node imports: stock.ts, the product editor and the shop pages
 * apply the same functions, and the SQL functions shop_product_live / shop_variant_availability mirror them.
 */

export const SHOP_ACCESS_MODES = ['open', 'password', 'coming_soon'] as const;
export type ShopAccessMode = (typeof SHOP_ACCESS_MODES)[number];
export const isShopAccessMode = (value: unknown): value is ShopAccessMode => (SHOP_ACCESS_MODES as readonly unknown[]).includes(value);

// ---------------------------------------------------------------------------
// Scheduled publish and hide

/** A product is in the shop when published and now is inside its optional window (publish_at <= now < hide_at). */
export function productLive(status: string, publishAt: Date | null, hideAt: Date | null, now: Date): boolean {
  if (status !== 'published') return false;
  if (publishAt && publishAt.getTime() > now.getTime()) return false;
  if (hideAt && hideAt.getTime() <= now.getTime()) return false;
  return true;
}

/** A hide time must come after the publish time when both are set. */
export function scheduleProblem(publishAt: Date | null, hideAt: Date | null): 'order' | null {
  return publishAt && hideAt && hideAt.getTime() <= publishAt.getTime() ? 'order' : null;
}

/** An ISO date-time string from the browser, or null for none; undefined when it is not a date. */
export function parseScheduleTime(value: unknown): Date | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? undefined : time;
}

// ---------------------------------------------------------------------------
// Pre-orders

/** A calendar date as YYYY-MM-DD (a real day), or null. */
export function parseShipDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

export const MAX_PREORDER_CAP = 1_000_000;

/** The field that makes a pre-order setting malformed, or null: a ship date is needed, and a cap is a whole number of 1 or more. */
export function preorderProblem(f: { preorder: boolean; shipDate: string | null; cap: number | null }): 'ship_date' | 'cap' | null {
  if (f.cap !== null && (!Number.isInteger(f.cap) || f.cap < 1 || f.cap > MAX_PREORDER_CAP)) return 'cap';
  if (f.preorder && !f.shipDate) return 'ship_date';
  return null;
}

/** True when `openUnits` (every open pre-order unit of the variant, the order being placed included) is within the cap. */
export const withinPreorderCap = (cap: number | null, openUnits: number): boolean => cap === null || openUnits <= cap;

/** The latest ship date among an order's pre-order lines (the date the whole order is promised by), or null. */
export function latestShipDate(dates: ReadonlyArray<string | null>): string | null {
  const set = dates.filter((d): d is string => !!d);
  return set.length ? set.reduce((a, b) => (a > b ? a : b)) : null;
}

/** A YYYY-MM-DD ship date for display in the visitor's language (the date itself, whatever the viewer's time zone). */
export function formatShipDate(date: string, locale: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return date;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(day);
  } catch {
    return date;
  }
}

// ---------------------------------------------------------------------------
// Bundles

export interface BundlePart { quantity: number; available: number | null; archived?: boolean }

/**
 * How many bundles the parts allow: the smallest whole number over the parts (an untracked part never limits);
 * null when no part limits it; 0 for no parts or an archived part. Same rule as shop_variant_availability.
 */
export function bundleAvailability(parts: readonly BundlePart[]): number | null {
  if (!parts.length) return 0;
  let best: number | null = null;
  for (const part of parts) {
    const units = part.archived ? 0 : part.available === null ? null : Math.floor(Math.max(part.available, 0) / part.quantity);
    if (units !== null && (best === null || units < best)) best = units;
  }
  return best;
}

export interface NeedLine { variantId: string; quantity: number }
export interface StockNeed { variantId: string; quantity: number; viaBundle: number }

/**
 * What a cart takes from stock, by variant (ascending id, the lock order): every plain line as itself, every bundle
 * line as its parts times the line quantity. `viaBundle` is the part that came from bundles: it never sells past
 * zero stock, even when the variant is itself on pre-order.
 */
export function expandBundleLines(lines: readonly NeedLine[], partsOf: (variantId: string) => ReadonlyArray<{ variantId: string; quantity: number }> | null): StockNeed[] {
  const needs = new Map<string, StockNeed>();
  const add = (variantId: string, quantity: number, viaBundle: number) => {
    const key = variantId.toLowerCase();
    const found = needs.get(key) ?? { variantId: key, quantity: 0, viaBundle: 0 };
    found.quantity += quantity;
    found.viaBundle += viaBundle;
    needs.set(key, found);
  };
  for (const line of lines) {
    const parts = partsOf(line.variantId.toLowerCase());
    if (parts) for (const part of parts) add(part.variantId, part.quantity * line.quantity, part.quantity * line.quantity);
    else add(line.variantId, line.quantity, 0);
  }
  return [...needs.values()].sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
}

/**
 * How many units of a tracked variant to reserve from stock now, or null when the line cannot be taken. Stock is
 * reserved up to what is available; a shortfall is allowed only on a pre-order variant and only for units that did
 * not come from a bundle (a bundle needs every part in stock).
 */
export function reserveFromStock(need: { quantity: number; viaBundle: number }, available: number, preorder: boolean): number | null {
  const reserve = Math.min(need.quantity, Math.max(available, 0));
  if (reserve < need.viaBundle) return null;
  if (reserve < need.quantity && !preorder) return null;
  return reserve;
}
