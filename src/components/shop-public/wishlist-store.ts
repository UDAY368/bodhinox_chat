'use client';

/**
 * A visitor's wishlist before the shop knows who they are, kept in their browser (localStorage). Only variant ids are
 * stored; names and prices come from the server. When the visitor comes in through a shop session (the WhatsApp code or a shop
 * link) the page saves this list to their contact once (POST …/wishlist, action 'sync') and clears it, so a price-drop
 * message can only ever go to a contact who was identified. Storage can be blocked, so every read and write is guarded and
 * the list then lives for the page only.
 */
export const WISHLIST_EVENT = 'bodhinox-shop-wishlist';
export const WISHLIST_LIMIT = 50;
const KEY = 'bodhinox-wishlist';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let memory: string[] = [];

/** Distinct well-formed variant ids, at most 50. */
export function cleanWishlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && UUID.test(v)).map((v) => v.toLowerCase()))].slice(0, WISHLIST_LIMIT);
}

export function readWishlist(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw !== null) return cleanWishlist(JSON.parse(raw));
  } catch { /* storage blocked: fall back to memory */ }
  return memory;
}

export function writeWishlist(ids: string[]): void {
  memory = cleanWishlist(ids);
  try {
    if (memory.length) window.localStorage.setItem(KEY, JSON.stringify(memory));
    else window.localStorage.removeItem(KEY);
  } catch { /* storage blocked: memory only */ }
  window.dispatchEvent(new CustomEvent(WISHLIST_EVENT));
}

/** For useSyncExternalStore: tells the page when the list changes (here or in another tab). */
export function subscribeWishlist(onChange: () => void): () => void {
  window.addEventListener(WISHLIST_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => { window.removeEventListener(WISHLIST_EVENT, onChange); window.removeEventListener('storage', onChange); };
}

/** The list as one string, so the store snapshot compares by value. */
export const wishlistSnapshot = (): string => readWishlist().join(',');

/** Save or remove one variant; answers whether it is saved afterwards. */
export function toggleWishlist(variantId: string): boolean {
  const current = readWishlist();
  const id = variantId.toLowerCase();
  const saved = current.includes(id);
  writeWishlist(saved ? current.filter((v) => v !== id) : [...current, id]);
  return !saved;
}
