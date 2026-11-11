// The read side of the comment funnel (Stage 3, Instagram › Insights): for the
// comments received in a range, how many went on to each later step, per post
// and per flow. The write side is comment-funnel.ts (worker marks).
//
// Every instagram_comment_events row is one comment, the top of the funnel; the
// later steps are columns on that row, so a step is counted once per comment:
//   dms       private reply sent (status 'sent', or 'unknown' when Meta's answer
//             was ambiguous, as the hourly guard in private-reply.ts counts it)
//   optIns    the person tapped "Opening DM" (opted_in_at)
//   clicks    a tracked link in the run was opened (tracked links only)
//   leads     the run collected an email or phone number
//   follows   the follow gate saw the person follow the account
// Counts only: no comment text, commenter id or message ever leaves these
// queries (none is stored). Runs inside withTenant (FORCE RLS) and names
// account_id explicitly so the (account_id, received_at) index serves the range.
import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import { AnalyticsInputError } from '@/lib/analytics/queries';
import type { AnalyticsRange } from '@/lib/analytics/range';

export interface CommentFunnelCounts {
  comments: number;
  dms: number;
  optIns: number;
  clicks: number;
  leads: number;
  follows: number;
}

export type CommentFunnelBy = 'post' | 'flow';

export interface CommentFunnelRow extends CommentFunnelCounts {
  /** The Instagram media id (by post; null for comments without one) or the flow id (by flow). */
  id: string | null;
  /** The flow's name (by flow); null by post or when the flow was deleted. */
  name: string | null;
}

export interface CommentFunnel {
  totals: CommentFunnelCounts;
  rows: CommentFunnelRow[];
}

export const COMMENT_FUNNEL_ROW_LIMIT = 100;

const counts = Prisma.sql`count(*)::int AS comments,
  (count(*) FILTER (WHERE e.private_reply_status IN ('sent','unknown')))::int AS dms,
  count(e.opted_in_at)::int AS "optIns", count(e.link_clicked_at)::int AS clicks,
  count(e.lead_captured_at)::int AS leads, count(e.followed_at)::int AS follows`;

export function parseFunnelBy(value: string | null): CommentFunnelBy {
  if (value == null || value === '' || value === 'post') return 'post';
  if (value === 'flow') return 'flow';
  throw new AnalyticsInputError('Invalid grouping');
}

/** Comments received in `range`, grouped by post or by the flow that handled them (busiest first). */
export async function commentFunnel(tx: TenantTransaction, accountId: string, range: AnalyticsRange,
  by: CommentFunnelBy): Promise<CommentFunnel> {
  const inRange = Prisma.sql`e.account_id=${accountId}::uuid
    AND e.received_at >= ${range.from.toISOString()}::timestamptz AND e.received_at < ${range.to.toISOString()}::timestamptz`;
  const [totals] = await tx.$queryRaw<CommentFunnelCounts[]>(Prisma.sql`
    SELECT ${counts} FROM instagram_comment_events e WHERE ${inRange}`);
  const rows = by === 'flow'
    ? await tx.$queryRaw<CommentFunnelRow[]>(Prisma.sql`
        SELECT r.flow_id::text AS id, f.name, ${counts}
        FROM instagram_comment_events e
        JOIN flow_runs r ON r.account_id=e.account_id AND r.id=e.flow_run_id
        LEFT JOIN flows f ON f.account_id=r.account_id AND f.id=r.flow_id
        WHERE ${inRange} GROUP BY r.flow_id, f.name
        ORDER BY comments DESC, r.flow_id LIMIT ${COMMENT_FUNNEL_ROW_LIMIT}`)
    : await tx.$queryRaw<CommentFunnelRow[]>(Prisma.sql`
        SELECT e.media_id AS id, NULL::text AS name, ${counts}
        FROM instagram_comment_events e WHERE ${inRange} GROUP BY e.media_id
        ORDER BY comments DESC, e.media_id LIMIT ${COMMENT_FUNNEL_ROW_LIMIT}`);
  return { totals, rows };
}
