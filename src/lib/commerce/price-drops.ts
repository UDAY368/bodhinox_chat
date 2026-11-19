/**
 * Price-drop nudges for the wishlist (store plan Phase 8, batch 5): the pure rules. A database trigger queues one
 * commerce.price_drop job in the transaction that lowers a wishlisted variant's price (so every code path that saves a price is
 * covered); price-drop-jobs.ts runs it. Only drops that matter are nudged: at least 5% off, and the live price must still be at
 * or below the drop's new price when the job runs. A contact gets at most one nudge per drop, and at most one per variant per 7 days.
 */
export const PRICE_DROP_JOB = 'commerce.price_drop';
/** The smallest drop worth a message, in percent of the old price. */
export const PRICE_DROP_MIN_PERCENT = 5;
/** Days before the same contact can be nudged about the same variant again. */
export const NUDGE_COOLDOWN_DAYS = 7;
/** Wishlist rows one job run messages; the rest is queued as the next run. */
export const PRICE_DROP_BATCH = 100;
export const WISHLIST_MAX = 50;

/** The percentage (0-100, rounded down) a price fell by; 0 when it did not fall or the old price is not a positive amount. */
export function dropPercent(fromMinor: number, toMinor: number): number {
  if (!Number.isSafeInteger(fromMinor) || !Number.isSafeInteger(toMinor) || fromMinor <= 0 || toMinor < 0 || toMinor >= fromMinor) return 0;
  return Math.floor(((fromMinor - toMinor) * 100) / fromMinor);
}

/** Whether a price change is a drop worth a nudge. */
export const isNudgeWorthyDrop = (fromMinor: number, toMinor: number): boolean => dropPercent(fromMinor, toMinor) >= PRICE_DROP_MIN_PERCENT;

/** Whether the live price still honours the drop (it may have gone back up before the job ran). */
export const dropStillHolds = (livePriceMinor: number | null, toMinor: number): boolean => livePriceMinor !== null && livePriceMinor <= toMinor;

/** Whether a nudge about this variant went to this contact recently enough to wait. */
export function inCooldown(lastNudgeAt: Date | null, now: Date): boolean {
  return lastNudgeAt !== null && now.getTime() - lastNudgeAt.getTime() < NUDGE_COOLDOWN_DAYS * 86_400_000;
}

export const priceNudgeIntentKey = (dropId: string, contactId: string) => `price_drop:${dropId}:${contactId}`;

export interface PriceDropPayload { variantId: string; fromMinor: number; toMinor: number; key: string; afterId?: string }
