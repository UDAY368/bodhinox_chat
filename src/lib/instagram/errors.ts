// Fixed Instagram error codes (Phase 11). Routes answer with the code and a
// translated message (Api.instagram.*), never Meta's text.

export const INSTAGRAM_ERROR_CODES = [
  'instagram_not_enabled',
  'forbidden',
  'invalid_request',
  'not_found',
  'rate_limited',
  'account_in_use',
  'limit_reached',
  'instagram_token_invalid',
  'instagram_permission_missing',
  'instagram_account_disconnected',
  'instagram_window_closed',
  'channel_not_supported',
  'contact_blocked',
  'identity_conflict',
  'identity_busy',
  'state_mismatch',
  'meta_error',
] as const;
export type InstagramErrorCode = (typeof INSTAGRAM_ERROR_CODES)[number];

const STATUS: Record<InstagramErrorCode, number> = {
  instagram_not_enabled: 503,
  forbidden: 403,
  invalid_request: 400,
  not_found: 404,
  rate_limited: 429,
  account_in_use: 409,
  limit_reached: 402,
  instagram_token_invalid: 409,
  instagram_permission_missing: 409,
  instagram_account_disconnected: 409,
  instagram_window_closed: 409,
  channel_not_supported: 409,
  contact_blocked: 409,
  identity_conflict: 409,
  identity_busy: 409,
  state_mismatch: 400,
  meta_error: 502,
};

/** An expected Instagram failure with a fixed code (never Meta's message). */
export class InstagramError extends Error {
  readonly status: number;
  constructor(readonly code: InstagramErrorCode) {
    super(`Instagram: ${code}`);
    this.name = 'InstagramError';
    this.status = STATUS[code];
  }
}

export function isInstagramErrorCode(value: unknown): value is InstagramErrorCode {
  return typeof value === 'string' && (INSTAGRAM_ERROR_CODES as readonly string[]).includes(value);
}
