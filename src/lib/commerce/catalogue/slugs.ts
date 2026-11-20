/**
 * Slugs for products and categories (store Batch 6), inside the caller's withTenant transaction on the app role (admins write the
 * catalogue; RLS checks it). One writer per workspace and kind at a time (advisory lock), so two saves never pick the same slug; the
 * partial unique index (account_id, slug) is the backstop and maps to `slug_taken`.
 *
 * When a slug changes, the old address keeps working: a 301 rule /p/<old> -> /p/<new> goes into shop_redirects (the table the shop's
 * redirect settings use; rules only answer a path no page answers). Rules that pointed at the old path are moved to the new one so a
 * chain never grows, and a rule from the new path is removed (that path is a live page again). When the workspace already has the
 * most rules the table allows (200), no rule is added: the id link (/p/<uuid>) still reaches the product. Paths only; audit holds ids.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { REDIRECT_LIMIT } from '../shop-insights-rules';
import { firstFreeSlug, isDerivedSlug, isShopSlug, slugBase, slugCandidate } from '../shop-paths';
import { CatalogueError } from './products';

export type SlugKind = 'product' | 'category';

async function lockSlugs(tx: TenantTransaction, accountId: string, kind: SlugKind) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`shop-slug:${kind}:${accountId}`}, 0))`;
}

async function takenSlugs(tx: TenantTransaction, accountId: string, kind: SlugKind, candidates: string[], exceptId: string | null): Promise<Set<string>> {
  const rows = kind === 'product'
    ? await tx.$queryRaw<{ slug: string }[]>`SELECT slug FROM shop_products WHERE account_id=${accountId}::uuid AND slug = ANY(${candidates}::text[])
        AND (${exceptId}::uuid IS NULL OR id<>${exceptId}::uuid)`
    : await tx.$queryRaw<{ slug: string }[]>`SELECT slug FROM shop_categories WHERE account_id=${accountId}::uuid AND slug = ANY(${candidates}::text[])
        AND (${exceptId}::uuid IS NULL OR id<>${exceptId}::uuid)`;
  return new Set(rows.map((r) => r.slug));
}

/** The body's `slug`: undefined when absent or empty (the name decides), else a valid slug or `invalid`. */
export function parseSlugInput(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new CatalogueError('invalid', 'slug');
  const slug = value.trim().toLowerCase();
  if (!isShopSlug(slug)) throw new CatalogueError('invalid', 'slug');
  return slug;
}

/**
 * The slug a row should have after this save. `requested` (the seller's own) must be free, else `slug_taken`. Without one: a new row,
 * a row without a slug, or a renamed row whose slug the seller never chose gets a free slug from its name; otherwise it keeps its slug.
 * Takes the per-workspace lock, so call it right before the write.
 */
export async function nextSlug(tx: TenantTransaction, accountId: string, kind: SlugKind, row: {
  id: string | null; name: string; current: { slug: string | null; name: string } | null; requested?: string;
}): Promise<string> {
  await lockSlugs(tx, accountId, kind);
  const { current } = row;
  if (row.requested !== undefined) {
    if (row.requested === current?.slug) return row.requested;
    if ((await takenSlugs(tx, accountId, kind, [row.requested], row.id)).size) throw new CatalogueError('slug_taken', 'slug');
    return row.requested;
  }
  if (current?.slug) {
    // Kept when the name did not change, when the seller chose this slug, or when the new name gives the same one.
    if (current.name === row.name || !row.id || !isDerivedSlug(current.slug, current.name, row.id) || isDerivedSlug(current.slug, row.name, row.id)) {
      return current.slug;
    }
  }
  // A new row has no id yet: the fallback fragment for a name with nothing latin comes from a random id instead.
  const base = slugBase(row.name, row.id ?? crypto.randomUUID());
  const candidates = Array.from({ length: 50 }, (_, i) => slugCandidate(base, i + 1));
  const free = firstFreeSlug(base, await takenSlugs(tx, accountId, kind, candidates, row.id));
  if (free) return free;
  // Fifty products of one name: the id fragment makes it unique.
  return slugCandidate(base.slice(0, 51).replace(/-+$/, ''), 1) + `-${(row.id ?? crypto.randomUUID()).replace(/-/g, '').slice(0, 8)}`;
}

/** Keep the old address working after a slug change (see the header). `kind` picks the path: /p/... or /c/.... */
export async function recordSlugMove(tx: TenantTransaction, accountId: string, userId: string, kind: SlugKind, from: string, to: string): Promise<void> {
  if (from === to) return;
  const prefix = kind === 'product' ? '/p/' : '/c/';
  const oldPath = `${prefix}${from}`, newPath = `${prefix}${to}`;
  // The same lock addRedirect takes: no admin rule can slip in between and make a loop.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`shop_redirects:${accountId}`}, 0))`;
  await tx.$executeRaw`DELETE FROM shop_redirects WHERE account_id=${accountId}::uuid AND from_path=${newPath}`;
  // Re-point chains ending at the old path (no UPDATE grant: delete and insert again, keeping each rule's code).
  const moved = await tx.$queryRaw<{ from_path: string; status_code: number }[]>`DELETE FROM shop_redirects
    WHERE account_id=${accountId}::uuid AND to_path=${oldPath} RETURNING from_path, status_code`;
  for (const rule of moved) {
    if (rule.from_path === newPath) continue;
    await tx.$executeRaw`INSERT INTO shop_redirects(account_id, from_path, to_path, status_code, created_by)
      VALUES(${accountId}::uuid, ${rule.from_path}, ${newPath}, ${rule.status_code}, ${userId}::uuid)`;
  }
  const [count] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shop_redirects WHERE account_id=${accountId}::uuid`;
  if ((count?.n ?? 0) >= REDIRECT_LIMIT) return;
  await tx.$executeRaw`INSERT INTO shop_redirects(account_id, from_path, to_path, status_code, created_by)
    VALUES(${accountId}::uuid, ${oldPath}, ${newPath}, 301, ${userId}::uuid) ON CONFLICT (account_id, from_path) DO NOTHING`;
}
