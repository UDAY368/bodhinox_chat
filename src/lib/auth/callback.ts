/** Require a local path before putting user-supplied text in a redirect. */
export const DEFAULT_NEXT_PATH = '/dashboard';
export function postLoginPath(invite: string | null, next: string | null, mfaRequired = false): string {
  const destination = invite ? `/join/${encodeURIComponent(invite)}` : safeNextPath(next);
  return mfaRequired ? `/mfa?next=${encodeURIComponent(destination)}` : destination;
}
export function safeNextPath(
  raw: string | null | undefined,
  fallback = DEFAULT_NEXT_PATH
): string {
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim();
  if (
    !value ||
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    return fallback;
  return value;
}
