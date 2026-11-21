// The Home business cards: revenue, bookings, ad spend and AI handled.
// Past days come from analytics_daily (the nightly rollup), today live
// (readDailyRows); bookings from the appointments summary (Batch 3) so the card
// matches the schedule; ad spend from synced Meta insights. Viewers see the
// bookings card only: money and AI figures are left out for them.

import { Prisma } from '@prisma/client';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { hasMinRole } from '@/lib/auth/roles';
import { bookingsSummary } from '@/lib/appointments/summary';
import { readDailyRows, sumDailyRows } from '@/lib/analytics/daily';
import { addDays, localDay, workspaceTimezone } from '@/lib/analytics/range';
import type { BusinessCards } from './types';

export async function loadBusinessCards(context: TenantContext, now: Date = new Date()): Promise<BusinessCards> {
  const seesMoney = !!context.role && hasMinRole(context.role, 'agent');
  return withTenant(context, async (tx) => {
    await tx.$queryRaw`SELECT set_config('statement_timeout', '15000', true)`;
    const timezone = await workspaceTimezone(tx, context.accountId);
    const today = localDay(now, timezone);
    const from = addDays(today, -6);
    const bookings = await bookingsSummary(tx, context.accountId, now);
    if (!seesMoney) return { timezone, revenue: null, bookings, adSpend: null, aiHandled: null };

    const days = await readDailyRows(tx, context.accountId, timezone, from, today, now);
    const week = sumDailyRows(days);
    const todayRow = days[days.length - 1];
    const spend = await tx.$queryRaw<{ currency: string; amount: number }[]>(Prisma.sql`
      SELECT currency, round(sum(spend), 2)::float8 AS amount FROM meta_ad_insights
      WHERE account_id=${context.accountId}::uuid AND level='campaign' AND currency IS NOT NULL
        AND day >= ${from}::date AND day <= ${today}::date
      GROUP BY currency ORDER BY currency LIMIT 10`);
    const hasAds = (await tx.$queryRaw<{ any: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM meta_ad_insights WHERE account_id=${context.accountId}::uuid) AS any`)[0]?.any;
    return {
      timezone,
      revenue: { todayMinor: todayRow.revenueMinor, last7DaysMinor: week.revenueMinor, paidOrders7Days: week.paidOrders },
      bookings,
      adSpend: hasAds ? { last7Days: spend.map((s) => ({ currency: s.currency, amount: Number(s.amount) })) } : null,
      aiHandled: { today: todayRow.aiClosed, last7Days: week.aiClosed },
    };
  });
}
