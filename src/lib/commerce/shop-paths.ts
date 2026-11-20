/**
 * Readable shop addresses (store Batch 6): /s/<handle>/p/<slug> and /s/<handle>/c/<slug>, and the one place every link to a product or a
 * category is built. Pure and browser-safe (the theme editor's preview and the public pages share it).
 *
 * A slug uses the collection format (^[a-z0-9]+(-[a-z0-9]+)*$, at most 60 characters), is unique per workspace for its kind, and never
 * has the shape of a uuid, so /p/<uuid> always means "the old id link" (answered with a 308 to the slug address). A row without a slug
 * yet (made by the previous release while the migration ran) is linked by its id, which still works.
 */
import { isSlug, slugify } from './catalogue/collection-rules';

export const SLUG_MAX = 60;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuidShaped = (value: string): boolean => UUID_SHAPE.test(value);

/** A slug a seller may choose: the collection format, at most 60 characters, never a uuid. */
export const isShopSlug = (value: unknown): value is string => isSlug(value) && !isUuidShaped(value);

/**
 * The slug a name gives: lower-case latin letters and digits joined by hyphens, at most 60 characters ("Neem Oil 200ml" ->
 * "neem-oil-200ml"). A name with nothing latin in it ("नीम तेल") falls back to the first eight characters of the row's id, so every
 * row gets a usable address. The same rules as shop_slug_base() in migration 20261206000100_shop_slugs_seo, which backfilled old rows.
 */
export function slugBase(name: string, id: string): string {
  let base = slugify(name);
  if (!base) base = id.replace(/[^0-9a-z]/gi, '').slice(0, 8).toLowerCase() || 'item';
  // Only a 36-character name could look like a uuid; one suffix keeps the two kinds of address apart.
  if (isUuidShaped(base)) base = `${base.slice(0, SLUG_MAX - 2)}-x`;
  return base;
}

/** "base", "base-2", "base-3" ... each cut to fit 60 characters (the base is shortened, never the number). */
export function slugCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  return `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
}

/** The first of `base`, `base-2` ... `base-<limit>` not in `taken`, or null when every one is taken. */
export function firstFreeSlug(base: string, taken: ReadonlySet<string>, limit = 50): string | null {
  for (let n = 1; n <= limit; n++) {
    const candidate = slugCandidate(base, n);
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/** True when `slug` is what `name` would give on its own, or a numbered copy of it: the seller never chose it, so a rename may move it. */
export function isDerivedSlug(slug: string, name: string, id: string): boolean {
  const base = slugBase(name, id);
  if (slug === base) return true;
  const m = /^(.*)-(\d{1,3})$/.exec(slug);
  return !!m && Number(m[2]) >= 2 && slugCandidate(base, Number(m[2])) === slug;
}

// ---------------------------------------------------------------------------------------------------------------- links

export interface Sluggable { id: string; slug?: string | null }

/** /s/<handle>/p/<slug> (or /p/<id> for a row that has no slug yet). */
export const productPath = (handle: string, product: Sluggable): string => `/s/${handle}/p/${product.slug || product.id}`;
/** /s/<handle>/c/<slug> (or /c/<id> for a row that has no slug yet). */
export const categoryPath = (handle: string, category: Sluggable): string => `/s/${handle}/c/${category.slug || category.id}`;

/** How a /p/<key> or /c/<key> segment is read: an old id link, a slug, or neither (the 404 path). */
export function readShopKey(key: unknown): { id: string } | { slug: string } | null {
  if (typeof key !== 'string') return null;
  if (isUuidShaped(key)) return { id: key.toLowerCase() };
  return isSlug(key) ? { slug: key } : null;
}

// ---------------------------------------------------------------------------------------------------------------- JSON-LD

/**
 * JSON for a <script type="application/ld+json"> body. JSON.stringify alone lets a product name such as "</script><script>..." end
 * the tag, so <, > and & become \u escapes (still the same JSON string), and U+2028/U+2029 too (line breaks to older parsers).
 */
export function jsonLdScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
