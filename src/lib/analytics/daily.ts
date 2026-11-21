// Daily analytics summary (analytics_daily, analytics_daily_ai_usage).
//
// computeDailyRows is the single place the per-day figures are defined; the
// worker rollup stores its output for past days and the dashboards call it live
// for today (and for any of the last few days the rollup has not reached yet).
// Days are the workspace timezone's (workspaceTimezone). Definitions:
// - messages in: customer messages; out: every other message (as the old
//   dashboard series), split by conversation channel;
// - opened / resolved: conversations created / resolved_at that day;
// - first reply: first-reply.ts, waits counted on the day they started;
// - AI replies: ai_generated, not failed; AI handoffs: ai_handoff_at that day;
//   AI closed ("AI handled"): aiClosedSql in queries.ts, on the resolve day;
// - paid orders and revenue: orders with paid_at that day, total (or subtotal
//   when no total was priced), per currency in minor units;
// - bookings: appointments booked for that day (status confirmed, completed or
//   no_show) on their own location's local day (appointments.local_date), the
//   same booked-status rule as the Home bookings card.
// Counts and durations only; no message text, contact or phone number.

import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { BOOKED_STATUSES } from '@/lib/appointments/summary';
import { firstRepliesSql, medianOf } from './first-reply';
import { aiClosedSql } from './queries';
import { addDays, dayCount, localDay, localMidnight, workspaceTimezone } from './range';

export { BOOKED_STATUSES };
/** Days the job re-rolls each run: yesterday and the two days before it. */
export const ROLLUP_DAYS = 3;
/** The longest span one backfill call rolls. */
export const BACKFILL_MAX_DAYS = 400;

export interface ChannelCounts { in: number; out: number }
export interface DailyRow {
  day: string;
  messagesIn: number;
  messagesOut: number;
  messagesByChannel: Record<string, ChannelCounts>;
  conversationsOpened: number;
  conversationsResolved: number;
  firstReplyCount: number;
  firstReplyUnanswered: number;
  firstReplyMedianSeconds: number | null;
  /** Answered waits of the day, seconds, ascending. */
  firstReplySeconds: number[];
  aiReplies: number;
  aiHandoffs: number;
  aiClosed: number;
  paidOrders: number;
  revenueMinor: Record<string, number>;
  bookings: number;
}
export interface DailyAiUsageRow { day: string; provider: string; model: string; calls: number; promptTokens: number; completionTokens: number }

const DAY = /^\d{4}-\d{2}-\d{2}$/;
function assertSpan(fromDay: string, toDay: string, max: number): void {
  if (!DAY.test(fromDay) || !DAY.test(toDay) || toDay < fromDay || dayCount(fromDay, toDay) > max) throw new RangeError('Invalid day span');
}

/** Per-day figures for every day from fromDay to toDay (inclusive) in `timezone`. */
export async function computeDailyRows(tx: TenantTransaction, accountId: string, timezone: string,
  fromDay: string, toDay: string): Promise<DailyRow[]> {
  assertSpan(fromDay, toDay, BACKFILL_MAX_DAYS);
  const from = Prisma.sql`${localMidnight(fromDay, timezone).toISOString()}::timestamptz`;
  const to = Prisma.sql`${localMidnight(addDays(toDay, 1), timezone).toISOString()}::timestamptz`;
  const dayOf = (column: string) => Prisma.sql`(${Prisma.raw(column)} AT TIME ZONE ${timezone})::date`;
  const rows = await tx.$queryRaw<{ row: DailyRow }[]>(Prisma.sql`
    WITH days AS (
      SELECT g::date AS day FROM generate_series(${fromDay}::date, ${toDay}::date, interval '1 day') g
    ), ${firstRepliesSql(accountId, from, to)},
    fr AS (
      SELECT ${dayOf('wait_at')} AS day, count(reply_at)::int AS n, (count(*) - count(reply_at))::int AS unanswered,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY secs))::numeric)::int AS median,
        COALESCE(array_agg(round(secs)::int ORDER BY secs) FILTER (WHERE secs IS NOT NULL), '{}') AS secs
      FROM first_replies GROUP BY 1
    ), msg AS (
      SELECT ${dayOf('m.created_at')} AS day, COALESCE(c.channel, 'whatsapp') AS channel,
        count(*) FILTER (WHERE m.sender_type='customer')::int AS i, count(*) FILTER (WHERE m.sender_type<>'customer')::int AS o,
        count(*) FILTER (WHERE m.ai_generated AND m.sender_type<>'customer' AND m.status<>'failed')::int AS ai
      FROM messages m JOIN conversations c ON c.account_id=m.account_id AND c.id=m.conversation_id
      WHERE m.account_id=${accountId}::uuid AND m.created_at >= ${from} AND m.created_at < ${to}
      GROUP BY 1, 2
    ), msg_day AS (
      SELECT day, sum(i)::int AS i, sum(o)::int AS o, sum(ai)::int AS ai,
        jsonb_object_agg(channel, jsonb_build_object('in', i, 'out', o)) AS by_channel
      FROM msg GROUP BY day
    ), opened AS (
      SELECT ${dayOf('created_at')} AS day, count(*)::int AS n FROM conversations
      WHERE account_id=${accountId}::uuid AND created_at >= ${from} AND created_at < ${to} GROUP BY 1
    ), resolved AS (
      SELECT ${dayOf('resolved_at')} AS day, count(*)::int AS n FROM conversations
      WHERE account_id=${accountId}::uuid AND resolved_at >= ${from} AND resolved_at < ${to} GROUP BY 1
    ), handoffs AS (
      SELECT ${dayOf('ai_handoff_at')} AS day, count(*)::int AS n FROM conversations
      WHERE account_id=${accountId}::uuid AND ai_handoff_at >= ${from} AND ai_handoff_at < ${to} GROUP BY 1
    ), ${aiClosedSql(accountId, from, to)},
    closed AS (SELECT ${dayOf('resolved_at')} AS day, count(*)::int AS n FROM ai_closed GROUP BY 1),
    paid AS (
      SELECT ${dayOf('paid_at')} AS day, currency, count(*)::int AS n, sum(COALESCE(total_minor, subtotal_minor))::bigint AS minor
      FROM orders WHERE account_id=${accountId}::uuid AND paid_at >= ${from} AND paid_at < ${to} GROUP BY 1, 2
    ), paid_day AS (
      SELECT day, sum(n)::int AS n, jsonb_object_agg(currency, minor) AS revenue FROM paid GROUP BY day
    ), booked AS (
      SELECT local_date AS day, count(*)::int AS n FROM appointments
      WHERE account_id=${accountId}::uuid AND local_date >= ${fromDay}::date AND local_date <= ${toDay}::date
        AND status = ANY(${[...BOOKED_STATUSES]}::text[])
      GROUP BY 1
    )
    SELECT json_build_object(
      'day', to_char(d.day, 'YYYY-MM-DD'),
      'messagesIn', COALESCE(md.i, 0), 'messagesOut', COALESCE(md.o, 0), 'messagesByChannel', COALESCE(md.by_channel, '{}'::jsonb),
      'conversationsOpened', COALESCE(op.n, 0), 'conversationsResolved', COALESCE(rs.n, 0),
      'firstReplyCount', COALESCE(fr.n, 0), 'firstReplyUnanswered', COALESCE(fr.unanswered, 0),
      'firstReplyMedianSeconds', fr.median, 'firstReplySeconds', COALESCE(fr.secs, '{}'),
      'aiReplies', COALESCE(md.ai, 0), 'aiHandoffs', COALESCE(ho.n, 0), 'aiClosed', COALESCE(cl.n, 0),
      'paidOrders', COALESCE(pd.n, 0), 'revenueMinor', COALESCE(pd.revenue, '{}'::jsonb), 'bookings', COALESCE(bk.n, 0)
    ) AS row
    FROM days d
    LEFT JOIN fr ON fr.day=d.day LEFT JOIN msg_day md ON md.day=d.day LEFT JOIN opened op ON op.day=d.day
    LEFT JOIN resolved rs ON rs.day=d.day LEFT JOIN handoffs ho ON ho.day=d.day LEFT JOIN closed cl ON cl.day=d.day
    LEFT JOIN paid_day pd ON pd.day=d.day LEFT JOIN booked bk ON bk.day=d.day
    ORDER BY d.day`);
  return rows.map(({ row }) => ({
    ...row,
    revenueMinor: Object.fromEntries(Object.entries(row.revenueMinor ?? {}).map(([c, v]) => [c, Number(v)])),
  }));
}

/** AI tokens per day, provider and model (ai_usage_log). Admin-only under RLS for the app role. */
export async function computeDailyAiUsage(tx: TenantTransaction, accountId: string, timezone: string,
  fromDay: string, toDay: string): Promise<DailyAiUsageRow[]> {
  assertSpan(fromDay, toDay, BACKFILL_MAX_DAYS);
  const from = localMidnight(fromDay, timezone), to = localMidnight(addDays(toDay, 1), timezone);
  const rows = await tx.$queryRaw<{ day: string; provider: string; model: string; calls: number; p: number; c: number }[]>`
    SELECT to_char((created_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS day, provider, model, count(*)::int AS calls,
      COALESCE(sum(prompt_tokens), 0)::float8 AS p, COALESCE(sum(completion_tokens), 0)::float8 AS c
    FROM ai_usage_log WHERE account_id=${accountId}::uuid AND created_at >= ${from} AND created_at < ${to}
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
  return rows.map((r) => ({ day: r.day, provider: r.provider, model: r.model, calls: Number(r.calls),
    promptTokens: Number(r.p), completionTokens: Number(r.c) }));
}

const worker = (accountId: string) => ({ accountId, role: 'owner' as const });

/**
 * Rolls fromDay..toDay for one workspace into analytics_daily and
 * analytics_daily_ai_usage: an upsert per day (a quiet day gets a zero row) and
 * the day's AI usage rows replaced, all in one transaction. Running it again
 * gives the same rows. Returns the days written.
 */
export async function rollupDays(accountId: string, fromDay: string, toDay: string): Promise<number> {
  assertSpan(fromDay, toDay, BACKFILL_MAX_DAYS);
  return withTenant(worker(accountId), async (tx) => {
    await tx.$queryRaw`SELECT set_config('statement_timeout', '120000', true)`;
    const timezone = await workspaceTimezone(tx, accountId);
    const days = await computeDailyRows(tx, accountId, timezone, fromDay, toDay);
    for (const d of days) {
      await tx.$executeRaw`
        INSERT INTO analytics_daily (account_id, day, messages_in, messages_out, messages_by_channel, conversations_opened,
          conversations_resolved, first_reply_count, first_reply_unanswered, first_reply_median_seconds, first_reply_seconds,
          ai_replies, ai_handoffs, ai_closed, paid_orders, revenue_minor, bookings, rolled_at)
        VALUES (${accountId}::uuid, ${d.day}::date, ${d.messagesIn}, ${d.messagesOut}, ${JSON.stringify(d.messagesByChannel)}::jsonb,
          ${d.conversationsOpened}, ${d.conversationsResolved}, ${d.firstReplyCount}, ${d.firstReplyUnanswered},
          ${d.firstReplyMedianSeconds}, ${d.firstReplySeconds}::int[], ${d.aiReplies}, ${d.aiHandoffs}, ${d.aiClosed},
          ${d.paidOrders}, ${JSON.stringify(d.revenueMinor)}::jsonb, ${d.bookings}, now())
        ON CONFLICT (account_id, day) DO UPDATE SET messages_in=EXCLUDED.messages_in, messages_out=EXCLUDED.messages_out,
          messages_by_channel=EXCLUDED.messages_by_channel, conversations_opened=EXCLUDED.conversations_opened,
          conversations_resolved=EXCLUDED.conversations_resolved, first_reply_count=EXCLUDED.first_reply_count,
          first_reply_unanswered=EXCLUDED.first_reply_unanswered, first_reply_median_seconds=EXCLUDED.first_reply_median_seconds,
          first_reply_seconds=EXCLUDED.first_reply_seconds, ai_replies=EXCLUDED.ai_replies, ai_handoffs=EXCLUDED.ai_handoffs,
          ai_closed=EXCLUDED.ai_closed, paid_orders=EXCLUDED.paid_orders, revenue_minor=EXCLUDED.revenue_minor,
          bookings=EXCLUDED.bookings, rolled_at=now()`;
    }
    await tx.$executeRaw`DELETE FROM analytics_daily_ai_usage WHERE account_id=${accountId}::uuid
      AND day >= ${fromDay}::date AND day <= ${toDay}::date`;
    for (const u of await computeDailyAiUsage(tx, accountId, timezone, fromDay, toDay)) {
      await tx.$executeRaw`INSERT INTO analytics_daily_ai_usage (account_id, day, provider, model, calls, prompt_tokens, completion_tokens)
        VALUES (${accountId}::uuid, ${u.day}::date, ${u.provider.slice(0, 64)}, ${u.model.slice(0, 200)}, ${u.calls},
          ${u.promptTokens}::bigint, ${u.completionTokens}::bigint)`;
    }
    return days.length;
  }, getWorkerPrisma());
}

/** The days the daily job rolls for a workspace at `now`: yesterday and the ROLLUP_DAYS-1 days before it. */
export function rollupWindow(timezone: string, now: Date = new Date()): { fromDay: string; toDay: string } {
  const today = localDay(now, timezone);
  return { fromDay: addDays(today, -ROLLUP_DAYS), toDay: addDays(today, -1) };
}

/**
 * Per-day figures for fromDay..toDay (inclusive): rolled days from
 * analytics_daily, and any day without a row (today, or a day the rollup has
 * not reached yet) computed live by computeDailyRows over the smallest span
 * that covers them. Every day is present, in order. Runs in the caller's tenant
 * transaction; analytics_daily is readable by every member of the workspace.
 */
export async function readDailyRows(tx: TenantTransaction, accountId: string, timezone: string,
  fromDay: string, toDay: string, now: Date = new Date()): Promise<DailyRow[]> {
  assertSpan(fromDay, toDay, BACKFILL_MAX_DAYS);
  const today = localDay(now, timezone);
  const stored = await tx.$queryRaw<{ row: DailyRow }[]>`
    SELECT json_build_object(
      'day', to_char(day, 'YYYY-MM-DD'), 'messagesIn', messages_in, 'messagesOut', messages_out,
      'messagesByChannel', messages_by_channel, 'conversationsOpened', conversations_opened,
      'conversationsResolved', conversations_resolved, 'firstReplyCount', first_reply_count,
      'firstReplyUnanswered', first_reply_unanswered, 'firstReplyMedianSeconds', first_reply_median_seconds,
      'firstReplySeconds', first_reply_seconds, 'aiReplies', ai_replies, 'aiHandoffs', ai_handoffs, 'aiClosed', ai_closed,
      'paidOrders', paid_orders, 'revenueMinor', revenue_minor, 'bookings', bookings) AS row
    FROM analytics_daily
    WHERE account_id=${accountId}::uuid AND day >= ${fromDay}::date AND day <= ${toDay}::date AND day < ${today}::date
    ORDER BY day`;
  const byDay = new Map(stored.map(({ row }) => [row.day, {
    ...row, revenueMinor: Object.fromEntries(Object.entries(row.revenueMinor ?? {}).map(([c, v]) => [c, Number(v)])),
  }]));
  const days: string[] = [];
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) days.push(d);
  const missing = days.filter((d) => !byDay.has(d));
  if (missing.length) {
    for (const row of await computeDailyRows(tx, accountId, timezone, missing[0], missing[missing.length - 1]))
      if (!byDay.has(row.day)) byDay.set(row.day, row);
  }
  return days.map((d) => byDay.get(d)!);
}

/** Sums of a run of days (medians combined exactly from the stored per-wait seconds). */
export function sumDailyRows(rows: readonly DailyRow[]) {
  const revenueMinor: Record<string, number> = {};
  for (const r of rows) for (const [c, v] of Object.entries(r.revenueMinor)) revenueMinor[c] = (revenueMinor[c] ?? 0) + v;
  const sum = (k: 'messagesIn' | 'messagesOut' | 'conversationsOpened' | 'conversationsResolved' | 'firstReplyCount'
    | 'firstReplyUnanswered' | 'aiReplies' | 'aiHandoffs' | 'aiClosed' | 'paidOrders' | 'bookings') =>
    rows.reduce((n, r) => n + r[k], 0);
  return {
    messagesIn: sum('messagesIn'), messagesOut: sum('messagesOut'), conversationsOpened: sum('conversationsOpened'),
    conversationsResolved: sum('conversationsResolved'), firstReplyCount: sum('firstReplyCount'),
    firstReplyUnanswered: sum('firstReplyUnanswered'),
    firstReplyMedianSeconds: medianOf(rows.flatMap((r) => r.firstReplySeconds)),
    aiReplies: sum('aiReplies'), aiHandoffs: sum('aiHandoffs'), aiClosed: sum('aiClosed'),
    paidOrders: sum('paidOrders'), revenueMinor, bookings: sum('bookings'),
  };
}
