'use client';

/**
 * The referral code a shop link carried (?ref=<code>), kept in the visitor's browser (localStorage, one key per shop) so it is still
 * there when the cart is sent to WhatsApp. Only a well-formed code is stored; the server looks it up again and ignores one it does not
 * know. Storage can be blocked, so every read and write is guarded and the code then lives for the page only.
 */
const CODE = /^[A-HJ-NP-Z2-9]{8}$/;
const memory = new Map<string, string>();
const key = (handle: string) => `bodhinox-ref:${handle}`;

/** The code in a query string value, upper-cased; null when it is not one. */
export function cleanRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return CODE.test(code) ? code : null;
}

/** Remember a code for this visit; `persist` false keeps it in memory only (the visitor has not agreed to storage). */
export function writeRef(handle: string, value: unknown, persist = true): void {
  const code = cleanRef(value);
  if (!code) return;
  memory.set(handle, code);
  if (!persist) return;
  try { window.localStorage.setItem(key(handle), code); } catch { /* storage blocked: memory only */ }
}

/** Save the code held in memory (the visitor has now agreed). */
export function persistRef(handle: string): void {
  const code = memory.get(handle);
  if (code) writeRef(handle, code, true);
}

/** Forget a stored code (the visitor declined). The code of the page they are on stays in memory for this visit. */
export function clearStoredRef(handle: string): void {
  try { window.localStorage.removeItem(key(handle)); } catch { /* storage blocked: nothing stored */ }
}

export function readRef(handle: string): string | null {
  try {
    const stored = cleanRef(window.localStorage.getItem(key(handle)));
    if (stored) return stored;
  } catch { /* storage blocked: fall back to memory */ }
  return memory.get(handle) ?? null;
}
