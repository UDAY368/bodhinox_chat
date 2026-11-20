/**
 * The returns queue on the Orders screen: every return of the workspace, newest first, a page at a time,
 * with the order it belongs to. Read in the caller's session (withTenant, app role, RLS), agents and above.
 * Names only for the customer: no phone numbers, no addresses.
 */

import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { OrderError } from './orders';
import { RETURN_STATUSES, type ReturnStatus } from './returns';

/** 'open': still to be handled (requested, received or inspected). */
export const RETURN_QUEUE_FILTERS = ['open', ...RETURN_STATUSES] as const;
export type ReturnQueueFilter = (typeof RETURN_QUEUE_FILTERS)[number];
export const RETURN_QUEUE_PAGE = 25;
const OPEN: readonly ReturnStatus[] = ['requested', 'received', 'inspected'];

export interface ReturnQueueItem {
  id: string;
  order_id: string;
  order_ref: string;
  status: ReturnStatus;
  source: 'staff' | 'buyer';
  /** A buyer's request staff have not approved yet. */
  pending_approval: boolean;
  /** Units coming back (sum of the lines' quantities). */
  units: number;
  is_exchange: boolean;
  contact_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReturnQueueQuery { status?: ReturnQueueFilter; page: number }

/** status (optional) and page (0-based) from the query string; anything else is a 400. */
export function parseReturnQueueQuery(params: URLSearchParams): ReturnQueueQuery {
  const status = params.get('status');
  const page = params.get('page');
  if (status && !(RETURN_QUEUE_FILTERS as readonly string[]).includes(status)) throw new OrderError(400, 'invalid', 'Invalid status');
  if (page && !/^\d{1,4}$/.test(page)) throw new OrderError(400, 'invalid', 'Invalid page');
  return { ...(status ? { status: status as ReturnQueueFilter } : {}), page: page ? Number(page) : 0 };
}

export async function listReturnQueue(ctx: TenantContext, query: ReturnQueueQuery): Promise<{ returns: ReturnQueueItem[]; total: number }> {
  const statuses: readonly string[] | null = !query.status ? null : query.status === 'open' ? OPEN : [query.status];
  return withTenant(ctx, async (tx) => {
    const [rows, [count]] = await Promise.all([
      tx.$queryRaw<Array<{
        id: string; order_id: string; external_id: string | null; status: ReturnStatus; source: string; approved_at: Date | null;
        units: number; is_exchange: boolean; contact_name: string | null; created_at: Date; updated_at: Date;
      }>>`
        SELECT r.id::text AS id, r.order_id::text AS order_id, o.external_id, r.status, r.source, r.approved_at,
          COALESCE((SELECT sum((l->>'qty')::int) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.items)='array' THEN r.items ELSE '[]'::jsonb END) l), 0)::int AS units,
          (r.exchange IS NOT NULL) AS is_exchange, c.name AS contact_name, r.created_at, r.updated_at
        FROM order_returns r
        JOIN orders o ON o.account_id=r.account_id AND o.id=r.order_id
        LEFT JOIN contacts c ON c.account_id=o.account_id AND c.id=o.contact_id
        WHERE r.account_id=${ctx.accountId}::uuid AND (${statuses}::text[] IS NULL OR r.status = ANY(${statuses}::text[]))
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${RETURN_QUEUE_PAGE} OFFSET ${query.page * RETURN_QUEUE_PAGE}`,
      tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM order_returns
        WHERE account_id=${ctx.accountId}::uuid AND (${statuses}::text[] IS NULL OR status = ANY(${statuses}::text[]))`,
    ]);
    return {
      total: count?.n ?? 0,
      returns: rows.map((r) => ({
        id: r.id, order_id: r.order_id, order_ref: r.external_id ? `#${r.external_id}` : r.order_id.slice(0, 8).toUpperCase(),
        status: r.status, source: r.source === 'buyer' ? 'buyer' : 'staff', pending_approval: r.source === 'buyer' && r.status === 'requested' && !r.approved_at,
        units: r.units, is_exchange: r.is_exchange, contact_name: r.contact_name,
        created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(),
      })),
    };
  });
}
