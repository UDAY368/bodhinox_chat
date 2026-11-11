// Instagram ref links (Stage 3): https://ig.me/m/<username>?ref=<key> opens a
// chat with the account and tells Bodhinox which link was used. Pure: no I/O,
// safe in client components (the ig_ref trigger editor and the Ref links page
// build links with it; the webhook path checks inbound refs with it).
//
// Two shapes on purpose:
// - IG_REF_KEY is what an author may create: short, URL-safe, readable.
// - IG_REF_STORED is what contact_channel_identities.last_ref accepts (its
//   CHECK, migration 20261117130300): Meta passes the ref through as typed, so
//   an inbound ref from a link Bodhinox did not make may be longer or use the
//   other characters Meta allows. Anything else is dropped, never stored.
// A ref is a label, not a secret or a tenant selector: the webhook still finds
// the workspace from the Instagram account the message arrived on.

/** A ref key an author may put in an ig_ref trigger (and so in a generated link). */
export const IG_REF_KEY = /^[A-Za-z0-9_-]{1,64}$/;
/** A ref Bodhinox may store from an inbound message (Meta allows a-z, A-Z, 0-9 and +/=-.:_ up to 250). */
export const IG_REF_STORED = /^[A-Za-z0-9_=+/.:-]{1,250}$/;
/** An Instagram username (letters, digits, periods, underscores; at most 30). */
const IG_USERNAME = /^[A-Za-z0-9._]{1,30}$/;

export function isRefKey(value: unknown): value is string {
  return typeof value === 'string' && IG_REF_KEY.test(value);
}

/** The ref of an inbound referral, trimmed, or null when there is none or it does not fit what we store. */
export function normalizeInboundRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ref = value.trim();
  return IG_REF_STORED.test(ref) ? ref : null;
}

/** Whether a trigger's keys include this ref (case-insensitive; keys that are not valid never match). */
export function refKeyMatches(keys: readonly unknown[], ref: string): boolean {
  const wanted = ref.toLowerCase();
  return keys.some((key) => isRefKey(key) && key.toLowerCase() === wanted);
}

/** The link that opens a chat with `username` carrying `ref`, or null when either is not valid. */
export function refLinkUrl(username: string, ref: string): string | null {
  const name = username.trim().replace(/^@/, '');
  if (!IG_USERNAME.test(name) || !isRefKey(ref)) return null;
  return `https://ig.me/m/${name}?ref=${encodeURIComponent(ref)}`;
}

/**
 * A ref key from what an author typed: spaces become hyphens, other
 * characters a key cannot hold are dropped, and it is cut to 64. Empty when
 * nothing usable is left.
 */
export function toRefKey(text: string): string {
  return text.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}
