'use client';

/** One JSON POST from the public shop's pages (same origin, so the account cookie rides along where its path allows). */
export async function shopPostJson<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; code: string }> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, data: data as T };
    const code = typeof data?.code === 'string' ? data.code : 'error';
    return { ok: false, code: data?.field === 'phone' ? 'invalid_phone' : code };
  } catch {
    return { ok: false, code: 'network' };
  }
}

const KNOWN_ERRORS = new Set(['invalid', 'invalid_cart', 'variant_unavailable', 'otp_unavailable', 'otp_invalid', 'otp_expired',
  'otp_locked', 'too_many', 'send_failed', 'send_uncertain', 'checkout_disabled', 'store_not_configured', 'contact_blocked',
  'whatsapp_order_unavailable', 'not_found', 'invalid_phone', 'network', 'signed_out', 'address_limit']);

/** The ShopPublic.errors key for a refusal code. */
export const shopErrorKey = (code: string) => `errors.${KNOWN_ERRORS.has(code) ? code : 'generic'}`;
