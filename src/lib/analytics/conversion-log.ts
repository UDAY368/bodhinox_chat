// Internal conversion events (Stage 5, 5F; the flow engine's Actions step
// calls logConversion, 5B). Not the Meta Conversions API, which keeps its own
// conversion_event step.
//
//   conversion_event_types  named by admins in Settings (archived, never deleted)
//   conversion_event_log    one row per run, step and type: the unique key
//                           (account_id, flow_run_id, node_key, event_type_id)
//                           makes a replayed step count once.
//
// The log is written by the worker role inside withTenant; members read it in
// Insights. Rows carry ids only: no customer content.
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import type { AnalyticsRange } from '@/lib/analytics/range';
import type { Channel } from '@/types';

export interface ConversionLogInput {
  eventTypeId: string;
  contactId: string | null;
  flowId: string | null;
  runId: string | null;
  nodeKey: string | null;
  channel: Channel;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const optionalId = (value: string | null) => (value != null && UUID.test(value) ? value : null);

/**
 * Records a conversion. Writes nothing for an unknown or archived event type,
 * another workspace's type (RLS hides it), or malformed ids, and nothing
 * without a run and step: the unique key (account, run, step, type) is what
 * makes a replay count once, and PostgreSQL treats NULLs in it as distinct.
 * Returns whether a row was written (false for a replay of the same run, step
 * and type).
 */
export async function logConversion(accountId: string, input: ConversionLogInput): Promise<boolean> {
  if (!UUID.test(accountId) || !UUID.test(input.eventTypeId)) return false;
  if (input.runId == null || !UUID.test(input.runId)) return false;
  if (input.channel !== 'whatsapp' && input.channel !== 'instagram') return false;
  const nodeKey = typeof input.nodeKey === 'string' && input.nodeKey.length >= 1 && input.nodeKey.length <= 200 ? input.nodeKey : null;
  if (nodeKey === null) return false;
  const written = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$executeRaw`
    INSERT INTO conversion_event_log(account_id,event_type_id,contact_id,flow_id,flow_run_id,node_key,channel)
    SELECT ${accountId}::uuid, t.id, ${optionalId(input.contactId)}::uuid, ${optionalId(input.flowId)}::uuid,
      ${input.runId}::uuid, ${nodeKey}, ${input.channel}
    FROM conversion_event_types t
    WHERE t.account_id=${accountId}::uuid AND t.id=${input.eventTypeId}::uuid AND t.archived_at IS NULL
    ON CONFLICT (account_id, flow_run_id, node_key, event_type_id) DO NOTHING`, getWorkerPrisma());
  return written > 0;
}

/** Conversion counts per event type in a range (Insights), busiest first; archived types included. */
export interface ConversionCount {
  id: string;
  name: string;
  archived: boolean;
  count: number;
}

export async function conversionCounts(tx: TenantTransaction, accountId: string, range: Pick<AnalyticsRange, 'from' | 'to'>,
  channel?: Channel): Promise<ConversionCount[]> {
  const byChannel = channel ? Prisma.sql`AND l.channel=${channel}` : Prisma.empty;
  return tx.$queryRaw<ConversionCount[]>(Prisma.sql`
    SELECT t.id::text, t.name, (t.archived_at IS NOT NULL) AS archived, count(l.id)::int AS count
    FROM conversion_event_types t
    LEFT JOIN conversion_event_log l ON l.account_id=t.account_id AND l.event_type_id=t.id
      AND l.occurred_at >= ${range.from.toISOString()}::timestamptz AND l.occurred_at < ${range.to.toISOString()}::timestamptz ${byChannel}
    WHERE t.account_id=${accountId}::uuid
    GROUP BY t.id, t.name, t.archived_at
    HAVING count(l.id) > 0 OR t.archived_at IS NULL
    ORDER BY count DESC, lower(t.name)
    LIMIT 100`);
}
