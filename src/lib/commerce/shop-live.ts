/**
 * The shop's live view (store plan Phase 8, batch 7). The public shop sends one small beacon per page view and one a minute while a tab
 * stays open and visible; the server adds 1 to a counter keyed by (workspace, minute, page key). Nothing identifies a visitor: no
 * address, user agent, cookie or id is read or stored, and the page key comes from a fixed set (see pageKeyOf). Because there is no
 * identifier, no consent is needed; the counter is an aggregate, not tracking of a person. Rows live two hours (the beacon, the report
 * and the hourly retention sweep delete older ones). A flood is capped: per minute a workspace counts at most LIVE_MAX_HITS_PER_MINUTE
 * hits and LIVE_MAX_PAGES_PER_MINUTE distinct pages (the rest fall under "other").
 */
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import {
  LIVE_MAX_HITS_PER_MINUTE, LIVE_MAX_PAGES_PER_MINUTE, LIVE_RETENTION_MINUTES, LIVE_WINDOW_MINUTES, pageKeyOf, summarizeLive, type LiveSummary,
} from './shop-insights-rules';
import { withPublicShop } from './public-shop';

type Exec = { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number> };

/** Count one page view for a published shop; false when there is no such open shop (the plain 404). */
export async function recordShopHit(handle: string, path: unknown): Promise<boolean> {
  const page = pageKeyOf(path);
  const done = await withPublicShop(handle, async (tx, accountId) => {
    const [state] = await tx.$queryRaw<{ total: bigint | null; pages: bigint; has_page: boolean }[]>`
      SELECT COALESCE(sum(hits), 0) AS total, count(*) AS pages, COALESCE(bool_or(page = ${page}), false) AS has_page
      FROM shop_live_hits WHERE account_id=${accountId}::uuid AND minute = date_trunc('minute', now())`;
    // Past the cap the beacon is accepted and not counted.
    if (Number(state?.total ?? 0) >= LIVE_MAX_HITS_PER_MINUTE) return true;
    const key = !state?.has_page && Number(state?.pages ?? 0) >= LIVE_MAX_PAGES_PER_MINUTE ? 'other' : page;
    const [row] = await tx.$queryRaw<{ inserted: boolean }[]>`
      INSERT INTO shop_live_hits(account_id, minute, page, hits) VALUES(${accountId}::uuid, date_trunc('minute', now()), ${key}, 1)
      ON CONFLICT (account_id, minute, page) DO UPDATE SET hits = LEAST(shop_live_hits.hits + 1, 100000)
      RETURNING (xmax = 0) AS inserted`;
    // A new row is the moment to drop the old ones (a cheap range delete on the key's first two columns).
    if (row?.inserted) await purgeLiveHitsTx(tx, accountId);
    return true;
  });
  return done === true;
}

export function purgeLiveHitsTx(tx: Exec, accountId: string): Promise<number> {
  return tx.$executeRaw`DELETE FROM shop_live_hits WHERE account_id=${accountId}::uuid
    AND minute < now() - make_interval(mins => ${LIVE_RETENTION_MINUTES}::int)`;
}

export interface LiveView extends LiveSummary {
  /** Page rows with a readable label where the key names a product or a category of this shop. */
  labelled: Array<{ page: string; hits: number; name: string | null }>;
}

/** The admin's live view (admins only: RLS and the route both check). */
export function loadLiveView(ctx: TenantContext): Promise<LiveView> {
  return withTenant(ctx, async (tx) => {
    await purgeLiveHitsTx(tx, ctx.accountId);
    const rows = await tx.$queryRaw<{ minute: Date; page: string; hits: number; now: Date }[]>`
      SELECT minute, page, hits, now() AS now FROM shop_live_hits
      WHERE account_id=${ctx.accountId}::uuid AND minute >= date_trunc('minute', now()) - make_interval(mins => ${LIVE_WINDOW_MINUTES - 1}::int)`;
    const summary = summarizeLive(rows.map((r) => ({ minute: r.minute.toISOString(), page: r.page, hits: r.hits })), rows[0]?.now ?? new Date());
    const productIds = summary.pages.filter((p) => p.page.startsWith('product:')).map((p) => p.page.slice(8));
    const categoryIds = summary.pages.filter((p) => p.page.startsWith('category:')).map((p) => p.page.slice(9));
    const names = new Map<string, string>();
    if (productIds.length) {
      for (const r of await tx.$queryRaw<{ id: string; name: string }[]>`SELECT id::text AS id, name FROM shop_products
        WHERE account_id=${ctx.accountId}::uuid AND id = ANY(${productIds}::uuid[])`) names.set(`product:${r.id}`, r.name);
    }
    if (categoryIds.length) {
      for (const r of await tx.$queryRaw<{ id: string; name: string }[]>`SELECT id::text AS id, name FROM shop_categories
        WHERE account_id=${ctx.accountId}::uuid AND id = ANY(${categoryIds}::uuid[])`) names.set(`category:${r.id}`, r.name);
    }
    return { ...summary, labelled: summary.pages.map((p) => ({ ...p, name: names.get(p.page)?.slice(0, 200) ?? null })) };
  });
}
