/**
 * Store plan Phase 8, batch 6: the link-in-bio page's rules. Pure: what an admin may save (a short bio, a capped list of
 * links with plain http(s) URLs, a few featured products) and what a visitor is shown.
 */
import { cleanLinkUrl, LINK_PAGE_LIMITS, type PageLink } from './link-page-limits';
import { StoreError } from './store-settings';

export { cleanLinkUrl, LINK_PAGE_LIMITS, type PageLink };

const CONTROL = /[\u0000-\u001f\u007f]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LinkPageInput { enabled: boolean; bio: string | null; links: PageLink[]; featuredProductIds: string[] }

export function parseLinkPage(body: unknown): LinkPageInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean') throw new StoreError('invalid', { field: 'enabled' });
  let bio: string | null = null;
  if (b.bio !== null && b.bio !== undefined && b.bio !== '') {
    if (typeof b.bio !== 'string') throw new StoreError('invalid', { field: 'bio' });
    bio = b.bio.trim();
    if (!bio || bio.length > LINK_PAGE_LIMITS.bio || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(bio)) throw new StoreError('invalid', { field: 'bio' });
  }
  if (!Array.isArray(b.links) || b.links.length > LINK_PAGE_LIMITS.links) throw new StoreError('invalid', { field: 'links' });
  const links = b.links.map((entry, i): PageLink => {
    const e = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const label = typeof e.label === 'string' ? e.label.trim() : '';
    const url = cleanLinkUrl(e.url);
    if (!label || label.length > LINK_PAGE_LIMITS.label || CONTROL.test(label)) throw new StoreError('invalid', { field: `links.${i}.label` });
    if (!url) throw new StoreError('invalid', { field: `links.${i}.url` });
    return { label, url };
  });
  if (!Array.isArray(b.featured_product_ids) || b.featured_product_ids.length > LINK_PAGE_LIMITS.featured) throw new StoreError('invalid', { field: 'featured_product_ids' });
  const featured = b.featured_product_ids.map((id) => {
    if (typeof id !== 'string' || !UUID.test(id)) throw new StoreError('invalid', { field: 'featured_product_ids' });
    return id.toLowerCase();
  });
  return { enabled: b.enabled, bio, links, featuredProductIds: [...new Set(featured)] };
}

/** What the stored JSON reads back as: anything that no longer passes is dropped, never shown. */
export function readStoredLinks(value: unknown): PageLink[] {
  if (!Array.isArray(value)) return [];
  const out: PageLink[] = [];
  for (const entry of value.slice(0, LINK_PAGE_LIMITS.links)) {
    const e = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const url = cleanLinkUrl(e.url);
    if (url && typeof e.label === 'string' && e.label.trim()) out.push({ label: e.label.trim().slice(0, LINK_PAGE_LIMITS.label), url });
  }
  return out;
}
