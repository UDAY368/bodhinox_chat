import { Prisma } from '@prisma/client';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { workspaceTimezone } from '@/lib/analytics/range';
import type { DashboardCharts } from './types';

export const CHART_RANGES = [7, 30, 90] as const;

/**
 * Dashboard chart aggregates grouped in SQL, so a busy workspace is never cut at
 * the data API's 1,000-row cap. Days and weeks follow the workspace timezone.
 * - series: messages per day for the last `days` days (customer = incoming,
 *   everything else = outgoing), every day present.
 * - responseTime: over the last 14 days, each customer wait (the first customer
 *   message after an outbound one) paired with the next outbound message; mean
 *   minutes per ISO weekday, this week and last week.
 * - dealsByStage: open deal count and value per stage.
 */
export async function loadDashboardCharts(context: TenantContext, days: number): Promise<DashboardCharts> {
  if (!(CHART_RANGES as readonly number[]).includes(days)) throw new RangeError('Unsupported chart range');
  const account = context.accountId;
  return withTenant(context, async (tx) => {
    const tz = await workspaceTimezone(tx, account);
    const today = Prisma.sql`(now() AT TIME ZONE ${tz})::date`;

    const series = await tx.$queryRaw<{ day: string; incoming: number; outgoing: number }[]>(Prisma.sql`
      WITH counts AS (
        SELECT (created_at AT TIME ZONE ${tz})::date AS day,
          count(*) FILTER (WHERE sender_type='customer')::int AS incoming,
          count(*) FILTER (WHERE sender_type<>'customer')::int AS outgoing
        FROM messages
        WHERE account_id=${account}::uuid
          AND created_at >= ((${today} - ${days - 1}::int)::timestamp AT TIME ZONE ${tz})
        GROUP BY 1
      )
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day, coalesce(c.incoming, 0) AS incoming, coalesce(c.outgoing, 0) AS outgoing
      FROM (SELECT g.at::date AS day FROM generate_series((${today} - ${days - 1}::int)::timestamp, ${today}::timestamp,
        interval '1 day') AS g(at)) d
      LEFT JOIN counts c ON c.day = d.day
      ORDER BY d.day`);

    const response = await tx.$queryRaw<{ summary: DashboardCharts['responseTime'] }[]>(Prisma.sql`
      WITH m AS (
        SELECT conversation_id, created_at, arrival_sequence, sender_type='customer' AS inbound,
          coalesce(lag(sender_type='customer') OVER w, false) AS prev_inbound
        FROM messages
        WHERE account_id=${account}::uuid AND created_at >= ((${today} - 13)::timestamp AT TIME ZONE ${tz})
        WINDOW w AS (PARTITION BY conversation_id ORDER BY created_at, arrival_sequence)
      ), runs AS (
        SELECT conversation_id, created_at, inbound,
          count(*) FILTER (WHERE inbound AND NOT prev_inbound)
            OVER (PARTITION BY conversation_id ORDER BY created_at, arrival_sequence ROWS UNBOUNDED PRECEDING) AS run
        FROM m
      ), samples AS (
        SELECT min(created_at) FILTER (WHERE inbound) AS customer_at, min(created_at) FILTER (WHERE NOT inbound) AS response_at
        FROM runs WHERE run > 0 GROUP BY conversation_id, run
      ), scored AS (
        SELECT extract(epoch FROM response_at - customer_at)::float8 / 60 AS minutes,
          extract(isodow FROM customer_at AT TIME ZONE ${tz})::int - 1 AS dow,
          customer_at AT TIME ZONE ${tz} AS local_at
        FROM samples WHERE response_at IS NOT NULL AND customer_at IS NOT NULL AND response_at >= customer_at
      ), week AS (
        SELECT date_trunc('week', now() AT TIME ZONE ${tz}) AS this_start
      )
      SELECT json_build_object(
        'buckets', (SELECT json_agg(json_build_object('dow', g.dow,
            'avgMinutes', (SELECT avg(s.minutes) FROM scored s WHERE s.dow = g.dow),
            'samples', (SELECT count(*) FROM scored s WHERE s.dow = g.dow)) ORDER BY g.dow)
          FROM generate_series(0, 6) AS g(dow)),
        'thisWeekAvg', (SELECT avg(minutes) FROM scored, week WHERE local_at >= week.this_start),
        'lastWeekAvg', (SELECT avg(minutes) FROM scored, week
          WHERE local_at >= week.this_start - interval '7 days' AND local_at < week.this_start)
      ) AS summary`);

    const dealsByStage = await tx.$queryRaw<DashboardCharts['dealsByStage']>(Prisma.sql`
      SELECT stage_id::text AS "stageId", count(*)::int AS count, coalesce(sum(value), 0)::float8 AS value
      FROM deals WHERE account_id=${account}::uuid AND status='open'
      GROUP BY stage_id`);

    return { timezone: tz, series, responseTime: response[0].summary, dealsByStage };
  });
}
