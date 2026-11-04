/**
 * Repeat-purchase consent (Phase 9 D13). Pure and client-safe: the storefront
 * imports the wording version, the follow-up job imports the refusal.
 *
 * The checkbox is unticked by default. placeOrder records what the customer
 * chose (true or false), when, and which wording they saw; an order placed
 * before the checkbox existed keeps NULL (unknown), and unknown never sends.
 */

/** Message key Storefront.marketingOptIn.<version>; recorded as orders.marketing_opt_in_version. */
export const MARKETING_OPT_IN_VERSION = 'reorder_offers_v1';

export interface MarketingConsentOrder {
  marketing_opt_in: boolean | null;
}

export interface MarketingConsentContact {
  blocked_at: Date | null;
  opted_out_at: Date | null;
}

/**
 * Why a marketing message (the repeat-purchase reminder) may not be sent, or
 * null. Stricter than the order-notice rule: an opt-out at any time refuses,
 * not only one after the purchase, and only an explicit opt-in allows.
 */
export function marketingConsentRefusal(order: MarketingConsentOrder, contact: MarketingConsentContact): string | null {
  if (contact.blocked_at) return 'contact_blocked';
  if (contact.opted_out_at) return 'opted_out';
  if (order.marketing_opt_in !== true) return 'no_marketing_consent';
  return null;
}
