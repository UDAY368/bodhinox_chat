// Instagram › Insights › Contacts (Stage 5, 5F): active, inactive and total
// Instagram contacts per local day of the workspace timezone.
//
//   total     contacts with an Instagram identity that existed by the end of
//             the day (contact_channel_identities.created_at)
//   active    of those, contacts who sent at least one Instagram message that
//             day (an inbound message: sender_type 'customer')
//   inactive  total - active (never below zero)
//
// Days are local days of the range's timezone (the workspace timezone), so a
// message at 23:30 UTC lands on the next day in a timezone ahead of UTC.
// Counts only: no contact, username or message leaves these queries. Runs
// inside withTenant (FORCE RLS) and names account_id for the indexes.
import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import { addDays, type AnalyticsRange } from '@/lib/analytics/range';

export interface ContactSeriesPoint {
  day: string;
  active: number;
  inactive: number;
  total: number;
}

/** Every local day from startDay to endDay inclusive. */
export function rangeDays(range: Pick<AnalyticsRange, 'startDay' | 'endDay'>): string[] {
  const days: string[] = [];
  for (let day = range.startDay; day <= range.endDay; day = addDays(day, 1)) days.push(day);
  return days;
}

/**
 * Builds the zero-filled series: `before` contacts existed before the first
 * day, `added` maps a day to the contacts created that day, `active` maps a day
 * to the distinct contacts who wrote that day. Days outside `days` are ignored.
 */
export function buildContactSeries(days: readonly string[], before: number, added: ReadonlyMap<string, number>,
  active: ReadonlyMap<string, number>): ContactSeriesPoint[] {
  let total = Math.max(0, before);
  return days.map((day) => {
    total += Math.max(0, added.get(day) ?? 0);
    // A contact who wrote that day exists by then; never show more active than total.
    const activeCount = Math.min(Math.max(0, active.get(day) ?? 0), total);
    return { day, active: activeCount, inactive: total - activeCount, total };
  });
}

/** The series for a range (one point per local day). */
export async function instagramContactSeries(tx: TenantTransaction, accountId: string,
  range: AnalyticsRange): Promise<ContactSeriesPoint[]> {
  const tz = range.timezone;
  const from = range.from.toISOString();
  const to = range.to.toISOString();
  const [{ before }] = await tx.$queryRaw<{ before: number }[]>(Prisma.sql`
    SELECT count(DISTINCT i.contact_id)::int AS before FROM contact_channel_identities i
    WHERE i.account_id=${accountId}::uuid AND i.channel='instagram' AND i.created_at < ${from}::timestamptz`);
  // A contact with two Instagram identities counts once, on its first.
  const added = await tx.$queryRaw<{ day: string; count: number }[]>(Prisma.sql`
    SELECT to_char((first_seen AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS day, count(*)::int AS count
    FROM (SELECT i.contact_id, min(i.created_at) AS first_seen FROM contact_channel_identities i
          WHERE i.account_id=${accountId}::uuid AND i.channel='instagram' GROUP BY i.contact_id) firsts
    WHERE first_seen >= ${from}::timestamptz AND first_seen < ${to}::timestamptz
    GROUP BY 1`);
  const active = await tx.$queryRaw<{ day: string; count: number }[]>(Prisma.sql`
    SELECT to_char((m.created_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS day, count(DISTINCT c.contact_id)::int AS count
    FROM messages m
    JOIN conversations c ON c.account_id=m.account_id AND c.id=m.conversation_id
    WHERE m.account_id=${accountId}::uuid AND c.channel='instagram' AND m.sender_type='customer'
      AND m.created_at >= ${from}::timestamptz AND m.created_at < ${to}::timestamptz
    GROUP BY 1`);
  return buildContactSeries(rangeDays(range), before ?? 0,
    new Map(added.map((row) => [row.day, row.count])), new Map(active.map((row) => [row.day, row.count])));
}
