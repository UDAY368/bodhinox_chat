/**
 * Shop redirects (store plan Phase 8, batch 7): an admin maps an old shop path to a new one (both inside /s/<handle>, never another host),
 * permanent (301) or temporary (302). Used only when a shop path would be a 404, so a live page is never hidden by a rule. At most 200
 * rules; a rule that would make a loop (or a chain longer than five hops) is refused; the public side follows a chain to its end in one
 * redirect. Admins write (RLS and the route both check); agents read.
 */
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import {
  cleanShopPath, redirectIssue, resolveRedirectChain, REDIRECT_CODES, type RedirectCode, type RedirectIssue, type RedirectRule,
} from './shop-insights-rules';
import { withPublicShop } from './public-shop';
import { auditStoreChange, StoreError, type StoreErrorCode } from './store-settings';

export interface RedirectView { id: string; from: string; to: string; code: RedirectCode; created_at: string }
interface Row { id: string; from_path: string; to_path: string; status_code: number; created_at: Date }

const view = (r: Row): RedirectView => ({ id: r.id, from: r.from_path, to: r.to_path, code: r.status_code === 302 ? 302 : 301, created_at: r.created_at.toISOString() });

const ISSUE: Record<RedirectIssue, StoreErrorCode> = {
  invalid_from: 'redirect_invalid_from', invalid_to: 'redirect_invalid_to', same: 'redirect_same', loop: 'redirect_loop',
  duplicate: 'redirect_duplicate', limit: 'redirect_limit',
};

export function listRedirects(ctx: TenantContext): Promise<RedirectView[]> {
  return withTenant(ctx, async (tx) => (await tx.$queryRaw<Row[]>`SELECT id::text AS id, from_path, to_path, status_code, created_at FROM shop_redirects
    WHERE account_id=${ctx.accountId}::uuid ORDER BY from_path`).map(view));
}

export interface RedirectInput { from: string; to: string; code: RedirectCode }

/** The body shape: two shop paths and 301 or 302 (default 301). `handle` lets a pasted "/s/<handle>/..." address be accepted. */
export function parseRedirectInput(body: unknown, handle: string): RedirectInput {
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const from = cleanShopPath(b.from, handle);
  const to = cleanShopPath(b.to, handle);
  const code = b.code === undefined ? 301 : b.code;
  if (!from) throw new StoreError('redirect_invalid_from');
  if (!to) throw new StoreError('redirect_invalid_to');
  if (!(REDIRECT_CODES as readonly unknown[]).includes(code)) throw new StoreError('invalid', { field: 'code' });
  return { from, to, code: code as RedirectCode };
}

export async function shopHandle(ctx: TenantContext): Promise<string> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.$queryRaw<{ handle: string }[]>`SELECT handle FROM shop_storefronts WHERE account_id=${ctx.accountId}::uuid`;
    return row?.handle ?? '';
  });
}

export async function addRedirect(ctx: TenantContext & { userId: string }, input: RedirectInput): Promise<RedirectView> {
  return withTenant(ctx, async (tx) => {
    // One writer at a time per workspace, so two admins cannot each pass the loop check and together make a loop.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`shop_redirects:${ctx.accountId}`}, 0))`;
    const existing = (await tx.$queryRaw<Row[]>`SELECT id::text AS id, from_path, to_path, status_code, created_at FROM shop_redirects
      WHERE account_id=${ctx.accountId}::uuid`).map((r): RedirectRule => ({ from: r.from_path, to: r.to_path, code: r.status_code === 302 ? 302 : 301 }));
    const issue = redirectIssue(input, existing);
    if (issue) throw new StoreError(ISSUE[issue]);
    const [row] = await tx.$queryRaw<Row[]>`INSERT INTO shop_redirects(account_id, from_path, to_path, status_code, created_by)
      VALUES(${ctx.accountId}::uuid, ${input.from}, ${input.to}, ${input.code}, ${ctx.userId}::uuid)
      RETURNING id::text AS id, from_path, to_path, status_code, created_at`;
    // Counts only: paths are the seller's own words and stay out of the audit trail.
    await auditStoreChange(tx, ctx, 'commerce.shop_redirect_added', row.id, { code: input.code });
    return view(row);
  });
}

export async function removeRedirect(ctx: TenantContext & { userId: string }, id: string): Promise<boolean> {
  return withTenant(ctx, async (tx) => {
    const removed = await tx.$executeRaw`DELETE FROM shop_redirects WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
    if (removed) await auditStoreChange(tx, ctx, 'commerce.shop_redirect_removed', id, {});
    return removed > 0;
  });
}

/**
 * Where a shop path that would be a 404 should go: the end of its redirect chain as a full /s/<handle>/... path and the status, or null.
 * Runs as a visitor (a locked shop gives nothing away).
 */
export async function resolveShopRedirect(handle: string, path: string): Promise<{ location: string; permanent: boolean } | null> {
  const from = cleanShopPath(path, handle);
  if (!from) return null;
  const hit = await withPublicShop(handle, async (tx, accountId) => {
    const rows = await tx.$queryRaw<Row[]>`SELECT id::text AS id, from_path, to_path, status_code, created_at FROM shop_redirects
      WHERE account_id=${accountId}::uuid`;
    return resolveRedirectChain(rows.map((r): RedirectRule => ({ from: r.from_path, to: r.to_path, code: r.status_code === 302 ? 302 : 301 })), from);
  });
  if (!hit) return null;
  return { location: hit.to === '/' ? `/s/${handle}` : `/s/${handle}${hit.to}`, permanent: hit.code === 301 };
}
