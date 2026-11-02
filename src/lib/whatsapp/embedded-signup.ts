/**
 * Embedded Signup (Meta Tech Provider flow): helpers shared by the browser
 * button and the server route. This file is client safe: no secrets, no
 * node-only imports. The server half lives in embedded-signup-connect.ts.
 *
 * Config (all three must be set, or the button hides and the route answers 503):
 *   NEXT_PUBLIC_META_APP_ID                  the Meta app the code is issued to
 *   NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID  the Facebook Login for Business configuration
 *   META_APP_SECRET_PRIMARY or META_APP_SECRET   server only; the code exchange uses
 *     META_APP_SECRET_PRIMARY when set, else the FIRST value of the
 *     comma-separated META_APP_SECRET (the webhook keeps accepting all of them).
 */

/** Origins Meta posts the WA_EMBEDDED_SIGNUP message from. */
export const EMBEDDED_SIGNUP_ORIGINS = ['https://www.facebook.com', 'https://web.facebook.com'] as const;

export function isEmbeddedSignupOrigin(origin: string): boolean {
  return (EMBEDDED_SIGNUP_ORIGINS as readonly string[]).includes(origin);
}

export interface EmbeddedSignupPublicConfig {
  appId: string;
  configId: string;
}

const META_ID = /^\d{1,32}$/;

/** Public config, or null when Embedded Signup is not configured. Reads NEXT_PUBLIC_ vars, so it is inlined into the client bundle. */
export function embeddedSignupPublicConfig(): EmbeddedSignupPublicConfig | null {
  const appId = process.env.NEXT_PUBLIC_META_APP_ID?.trim() ?? '';
  const configId = process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID?.trim() ?? '';
  if (!META_ID.test(appId) || !META_ID.test(configId)) return null;
  return { appId, configId };
}

export type EmbeddedSignupEvent =
  | { kind: 'finish'; wabaId: string; phoneNumberId: string }
  | { kind: 'cancel'; step: string | null }
  | { kind: 'error'; message: string | null };

/**
 * Parse a window message from the signup popup. Returns null for anything that
 * is not a WA_EMBEDDED_SIGNUP event from a Facebook origin. The caller must
 * pass the event origin; data may be a JSON string or an object.
 */
export function parseEmbeddedSignupMessage(origin: string, data: unknown): EmbeddedSignupEvent | null {
  if (!isEmbeddedSignupOrigin(origin)) return null;
  let payload: unknown = data;
  if (typeof data === 'string') {
    try {
      payload = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== 'object') return null;
  const { type, event, data: inner } = payload as { type?: unknown; event?: unknown; data?: unknown };
  if (type !== 'WA_EMBEDDED_SIGNUP') return null;
  const fields = (inner && typeof inner === 'object' ? inner : {}) as Record<string, unknown>;
  if (typeof event === 'string' && event.startsWith('FINISH')) {
    const wabaId = fields.waba_id;
    const phoneNumberId = fields.phone_number_id;
    if (typeof wabaId !== 'string' || typeof phoneNumberId !== 'string') return null;
    if (!META_ID.test(wabaId) || !META_ID.test(phoneNumberId)) return null;
    return { kind: 'finish', wabaId, phoneNumberId };
  }
  if (event === 'CANCEL') {
    return { kind: 'cancel', step: typeof fields.current_step === 'string' ? fields.current_step : null };
  }
  if (event === 'ERROR') {
    return { kind: 'error', message: typeof fields.error_message === 'string' ? fields.error_message : null };
  }
  return null;
}

/** The POST body the button sends to /api/whatsapp/embedded-signup. */
export interface EmbeddedSignupRequest {
  code: string;
  waba_id: string;
  phone_number_id: string;
}

export function parseEmbeddedSignupRequest(body: unknown): EmbeddedSignupRequest | null {
  if (!body || typeof body !== 'object') return null;
  const { code, waba_id, phone_number_id } = body as Record<string, unknown>;
  if (typeof code !== 'string' || code.length < 1 || code.length > 2048 || /\s/.test(code)) return null;
  if (typeof waba_id !== 'string' || !META_ID.test(waba_id)) return null;
  if (typeof phone_number_id !== 'string' || !META_ID.test(phone_number_id)) return null;
  return { code, waba_id, phone_number_id };
}
