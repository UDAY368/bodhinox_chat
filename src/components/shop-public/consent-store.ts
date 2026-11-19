'use client';

/**
 * The visitor's choice about optional storage in one shop (store plan Phase 8, batch 7). Essential storage needs no consent and
 * is never gated: the cart, the wishlist (both stored only because the visitor asked for them), the shop password cookie and the
 * choice below. The one optional item is the referral code of a ?ref= link: it is kept in the visitor's browser only after they
 * accept. Until then (or after a decline) it lives in memory for the visit, so the order still counts when the cart is sent from
 * the same tab. The aggregate live-view counter stores nothing in the browser and needs no consent. Storage can be blocked, so
 * every read and write is guarded; with it blocked the choice lasts for the visit.
 */
export type Consent = 'yes' | 'no';
const memory = new Map<string, Consent>();
const key = (handle: string) => `bodhinox-consent:${handle}`;

export function readConsent(handle: string): Consent | null {
  try {
    const stored = window.localStorage.getItem(key(handle));
    if (stored === 'yes' || stored === 'no') return stored;
  } catch { /* storage blocked: fall back to memory */ }
  return memory.get(handle) ?? null;
}

export function writeConsent(handle: string, value: Consent): void {
  memory.set(handle, value);
  try { window.localStorage.setItem(key(handle), value); } catch { /* storage blocked: memory only */ }
}
