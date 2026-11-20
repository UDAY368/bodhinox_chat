// The header's global search (Ctrl/Cmd+K): a few contacts, orders, products
// and bookings matching the term, in one tenant transaction of small bounded
// queries. Orders and products are listed for agents and above only, as their
// own list routes are (GET /api/commerce/orders, /api/commerce/shop/products);
// bookings and contacts for every member. Numbers are masked for a masked
// member, and their phone search is limited the same way as everywhere else.
import { Prisma } from '@prisma/client';

import { hasMinRole } from '@/lib/auth/roles';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { loadPhoneMask } from '@/lib/inbox/masking-apply';
import { searchAppointments } from '@/lib/appointments/search';
import { contactHit, contactMatchSql, contactRows } from './contacts';
import { containsPattern, referenceTerm } from './normalise';

export interface GlobalSearchItem {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  /** ISO time shown next to orders (placed) and bookings (starts). */
  at?: string;
}

export interface GlobalSearchResult {
  contacts: GlobalSearchItem[];
  orders: GlobalSearchItem[];
  products: GlobalSearchItem[];
  bookings: GlobalSearchItem[];
}

export const GLOBAL_SEARCH_MIN_LENGTH = 2;
export const GLOBAL_SEARCH_DEFAULT_LIMIT = 5;
export const GLOBAL_SEARCH_MAX_LIMIT = 8;

const empty = (): GlobalSearchResult => ({ contacts: [], orders: [], products: [], bookings: [] });

/** How an order is named on screen (order-state.ts orderRef): its channel reference, else the id's first 8 characters. */
export function orderTitle(id: string, externalId: string | null): string {
  return externalId ? `#${externalId}` : id.slice(0, 8).toUpperCase();
}

export async function globalSearch(ctx: TenantContext, input: { q: string; limit?: number }): Promise<GlobalSearchResult> {
  const q = input.q.trim();
  if (q.length < GLOBAL_SEARCH_MIN_LENGTH) return empty();
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? GLOBAL_SEARCH_DEFAULT_LIMIT), 1), GLOBAL_SEARCH_MAX_LIMIT);
  const staff = !!ctx.role && hasMinRole(ctx.role, 'agent');
  const like = containsPattern(q);
  const ref = referenceTerm(q);

  return withTenant(ctx, async (tx) => {
    const maskPhones = await loadPhoneMask(tx, ctx);
    const result = empty();
    const match = contactMatchSql(q, maskPhones);

    result.contacts = (await contactRows(tx, ctx.accountId, { term: q, maskPhones, limit })).map((row) => {
      const hit = contactHit(row, maskPhones);
      return { id: hit.id, title: hit.name || hit.phone || '', subtitle: hit.name ? hit.phone ?? '' : '', href: `/contacts/${hit.id}` };
    });

    if (staff) {
      // The on-screen reference is "#<external id>" or the id's first 8 characters.
      const idPrefix = /^[0-9a-f-]{2,36}$/.test(ref) ? Prisma.sql`OR o.id::text LIKE ${`${ref}%`}` : Prisma.empty;
      const orders = await tx.$queryRaw<{ id: string; external_id: string | null; created_at: Date; contact_name: string | null }[]>(Prisma.sql`
        SELECT o.id::text AS id, o.external_id, o.created_at, c.name AS contact_name
        FROM orders o LEFT JOIN contacts c ON c.account_id=o.account_id AND c.id=o.contact_id
        WHERE o.account_id=${ctx.accountId}::uuid
          AND (o.external_id ILIKE ${containsPattern(ref)} ${idPrefix} OR (c.id IS NOT NULL ${match}))
        ORDER BY o.created_at DESC, o.id DESC LIMIT ${limit}`);
      result.orders = orders.map((o) => ({
        id: o.id, title: orderTitle(o.id, o.external_id), subtitle: o.contact_name ?? '',
        href: `/commerce/orders/${o.id}`, at: o.created_at.toISOString(),
      }));

      const products = await tx.$queryRaw<{ id: string; name: string; sku: string | null }[]>(Prisma.sql`
        SELECT p.id::text AS id, p.name,
          (SELECT v.sku FROM shop_variants v WHERE v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL
            ORDER BY (v.sku ILIKE ${like}) DESC, v.position, v.id LIMIT 1) AS sku
        FROM shop_products p
        WHERE p.account_id=${ctx.accountId}::uuid AND p.status <> 'archived'
          AND (p.name ILIKE ${like} OR EXISTS (SELECT 1 FROM shop_variants v
            WHERE v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL AND v.sku ILIKE ${like}))
        ORDER BY p.updated_at DESC, p.id DESC LIMIT ${limit}`);
      result.products = products.map((p) => ({ id: p.id, title: p.name, subtitle: p.sku ?? '', href: `/commerce/catalogue/${p.id}` }));
    }

    result.bookings = await searchAppointments(tx, ctx.accountId, q, limit, maskPhones);
    return result;
  });
}
