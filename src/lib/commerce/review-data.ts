/**
 * Store plan Phase 3, package 4: reading and moderating product reviews.
 *
 * - Admin list and moderation run with the caller's live session (app role, RLS):
 *   agents read, admins publish or hide (the column grant lets the app role change
 *   only status, moderated_by and moderated_at). Audit rows carry ids and the new
 *   status only.
 * - The public shop reads through its worker transaction and gets published
 *   reviews only: stars, text, the first-name initial and the date. A phone number,
 *   a full name or a contact id never leaves the database for the public.
 */
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { PUBLIC_REVIEW_LIMIT, type RatingSummary, type ReviewStatus } from './reviews';
import { auditStoreChange, isUuid, StoreError } from './store-settings';

// ---------------------------------------------------------------------------
// Public shop

export interface PublicReview { rating: number; body: string | null; reviewer: string | null; date: string }
export interface ProductReviews { summary: RatingSummary | null; latest: PublicReview[] }

/** Average and count of the published reviews of these products: one grouped query for any number of products. */
export async function loadRatingSummaries(tx: TenantTransaction, accountId: string, productIds: string[]): Promise<Map<string, RatingSummary>> {
  const out = new Map<string, RatingSummary>();
  if (!productIds.length) return out;
  const rows = await tx.$queryRaw<{ product_id: string; n: number; avg: number }[]>`
    SELECT product_id::text AS product_id, count(*)::int AS n, avg(rating)::float8 AS avg FROM shop_reviews
    WHERE account_id=${accountId}::uuid AND status='published' AND product_id = ANY(${productIds}::uuid[]) GROUP BY product_id`;
  for (const r of rows) out.set(r.product_id, { average: Math.round(r.avg * 10) / 10, count: r.n });
  return out;
}

/** One product's rating summary and its latest published reviews. */
export async function loadProductReviews(tx: TenantTransaction, accountId: string, productId: string): Promise<ProductReviews> {
  const summary = (await loadRatingSummaries(tx, accountId, [productId])).get(productId) ?? null;
  const rows = summary ? await tx.$queryRaw<{ rating: number; body: string | null; reviewer_initial: string | null; created_at: Date }[]>`
    SELECT rating::int AS rating, body, reviewer_initial, created_at FROM shop_reviews
    WHERE account_id=${accountId}::uuid AND product_id=${productId}::uuid AND status='published'
    ORDER BY created_at DESC, id DESC LIMIT ${PUBLIC_REVIEW_LIMIT}` : [];
  return { summary, latest: rows.map((r) => ({ rating: r.rating, body: r.body, reviewer: r.reviewer_initial, date: r.created_at.toISOString() })) };
}

// ---------------------------------------------------------------------------
// Admin

export interface ReviewView {
  id: string;
  rating: number;
  body: string | null;
  status: ReviewStatus;
  product_id: string;
  product_name: string;
  reviewer: string | null;
  created_at: string;
}

export const REVIEW_PAGE_SIZE = 50;

interface ReviewRow { id: string; rating: number; body: string | null; status: ReviewStatus; product_id: string; product_name: string;
  reviewer_initial: string | null; created_at: Date }

const toView = (r: ReviewRow): ReviewView => ({
  id: r.id, rating: r.rating, body: r.body, status: r.status, product_id: r.product_id, product_name: r.product_name,
  reviewer: r.reviewer_initial, created_at: r.created_at.toISOString(),
});

/** A paging cursor is "<created_at ISO>|<id>" of the last row seen. */
export function parseReviewCursor(value: unknown): { at: Date; id: string } | null {
  if (typeof value !== 'string' || value.length > 80) return null;
  const [iso, id] = value.split('|');
  const at = new Date(iso ?? '');
  return Number.isNaN(at.getTime()) || !isUuid(id) ? null : { at, id: id.toLowerCase() };
}

export async function listReviews(ctx: TenantContext, filter: { status: ReviewStatus | null; before: { at: Date; id: string } | null }):
  Promise<{ reviews: ReviewView[]; next: string | null }> {
  const { status, before } = filter;
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<ReviewRow[]>`
      SELECT r.id::text AS id, r.rating::int AS rating, r.body, r.status, r.product_id::text AS product_id, p.name AS product_name,
        r.reviewer_initial, r.created_at
      FROM shop_reviews r JOIN shop_products p ON p.account_id=r.account_id AND p.id=r.product_id
      WHERE r.account_id=${ctx.accountId}::uuid AND (${status}::text IS NULL OR r.status=${status})
        AND (${before?.at ?? null}::timestamptz IS NULL OR (r.created_at, r.id) < (${before?.at ?? null}::timestamptz, ${before?.id ?? null}::uuid))
      ORDER BY r.created_at DESC, r.id DESC LIMIT ${REVIEW_PAGE_SIZE + 1}`;
    const page = rows.slice(0, REVIEW_PAGE_SIZE);
    const last = page[page.length - 1];
    return { reviews: page.map(toView), next: rows.length > REVIEW_PAGE_SIZE && last ? `${last.created_at.toISOString()}|${last.id}` : null };
  });
}

/** Publish or hide a review (admins). 404 when it is not in this workspace; agents are refused by the database. */
export async function moderateReview(ctx: TenantContext & { userId: string }, id: string, status: unknown): Promise<ReviewView> {
  if (!isUuid(id)) throw new StoreError('not_found');
  if (status !== 'published' && status !== 'hidden') throw new StoreError('invalid', { field: 'status' });
  return withTenant(ctx, async (tx) => {
    const changed = await tx.$executeRaw`UPDATE shop_reviews SET status=${status}, moderated_by=${ctx.userId}::uuid, moderated_at=now()
      WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
    if (!changed) throw new StoreError('not_found');
    await auditStoreChange(tx, ctx, 'commerce.review_moderated', id, { status });
    const [row] = await tx.$queryRaw<ReviewRow[]>`
      SELECT r.id::text AS id, r.rating::int AS rating, r.body, r.status, r.product_id::text AS product_id, p.name AS product_name,
        r.reviewer_initial, r.created_at
      FROM shop_reviews r JOIN shop_products p ON p.account_id=r.account_id AND p.id=r.product_id
      WHERE r.account_id=${ctx.accountId}::uuid AND r.id=${id}::uuid`;
    return toView(row);
  });
}
