/** Client-safe parts of the link-in-bio page rules (link-page-rules.ts holds the validators and pulls in server code). */

export const LINK_PAGE_LIMITS = { bio: 280, links: 12, label: 60, url: 500, featured: 6 } as const;

const CONTROL = /[\u0000-\u001f\u007f]/;

/** An absolute http(s) URL with a host and no credentials, as the normalised string; null for anything else (javascript:, data:, relative, user:pass@). */
export function cleanLinkUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > LINK_PAGE_LIMITS.url || CONTROL.test(raw) || /\s/.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname || url.username || url.password) return null;
  return url.toString();
}

export interface PageLink { label: string; url: string }
