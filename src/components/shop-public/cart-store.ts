'use client';

/**
 * The public shop's cart, kept in the visitor's browser (localStorage, one
 * key per shop). Only variant ids and quantities are stored; names and prices
 * always come back from the server (POST …/cart). Storage can be missing or
 * blocked (private windows), so every read and write is guarded and the cart
 * then lives for the page only.
 */
export interface BrowserCartLine { variantId: string; qty: number }

export const CART_EVENT = 'bodhinox-shop-cart';
export const MAX_QTY = 99;
export const MAX_LINES = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const memory = new Map<string, BrowserCartLine[]>();
const key = (handle: string) => `bodhinox-cart:${handle}`;

/** Keep only well-formed lines, merged by variant, quantities clamped. */
export function cleanCart(value: unknown): BrowserCartLine[] {
  if (!Array.isArray(value)) return [];
  const merged = new Map<string, number>();
  for (const line of value) {
    const id = line && typeof line === 'object' ? (line as Record<string, unknown>).variantId : null;
    const qty = line && typeof line === 'object' ? (line as Record<string, unknown>).qty : null;
    if (typeof id !== 'string' || !UUID.test(id) || typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1) continue;
    merged.set(id, Math.min(MAX_QTY, (merged.get(id) ?? 0) + qty));
  }
  return [...merged].slice(0, MAX_LINES).map(([variantId, qty]) => ({ variantId, qty }));
}

export function readCart(handle: string): BrowserCartLine[] {
  try {
    const raw = window.localStorage.getItem(key(handle));
    if (raw !== null) return cleanCart(JSON.parse(raw));
  } catch { /* storage blocked: fall back to memory */ }
  return memory.get(handle) ?? [];
}

export function writeCart(handle: string, lines: BrowserCartLine[]): void {
  const clean = cleanCart(lines);
  memory.set(handle, clean);
  try {
    if (clean.length) window.localStorage.setItem(key(handle), JSON.stringify(clean));
    else window.localStorage.removeItem(key(handle));
  } catch { /* storage blocked: memory only */ }
  window.dispatchEvent(new CustomEvent(CART_EVENT, { detail: handle }));
}

export function addToCart(handle: string, variantId: string, qty: number): void {
  writeCart(handle, [...readCart(handle), { variantId, qty }]);
}

export function setLineQty(handle: string, variantId: string, qty: number): void {
  writeCart(handle, readCart(handle).flatMap((l) => (l.variantId !== variantId ? [l] : qty > 0 ? [{ variantId, qty: Math.min(MAX_QTY, qty) }] : [])));
}

export const cartCount = (lines: BrowserCartLine[]) => lines.reduce((n, l) => n + l.qty, 0);
