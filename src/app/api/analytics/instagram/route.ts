// GET /api/analytics/instagram?preset=&from=&to=[&by=post|flow]
// Instagram › Insights (viewer and above):
//   funnel       the comment funnel (comments, DMs, opened DMs, link clicks,
//                leads, new followers) per post or per flow; by flow each row
//                also carries its CTR (src/lib/flows/link-tracking.ts)
//   contacts     active, inactive and total Instagram contacts per day (Stage 5)
//   revenue      paid payment links from automations (Stage 5; agents and above,
//                `visible: false` for a viewer)
//   conversions  conversion event counts per event type (Stage 5)
// Counts and amounts only; see src/lib/instagram/funnel.ts, contact-series.ts,
// revenue.ts and src/lib/analytics/conversion-log.ts.

import { analyticsReport } from '@/lib/analytics/http';
import { conversionCounts } from '@/lib/analytics/conversion-log';
import { clickThroughRate, flowLinkStats } from '@/lib/flows/link-tracking';
import { instagramContactSeries } from '@/lib/instagram/contact-series';
import { commentFunnel, parseFunnelBy } from '@/lib/instagram/funnel';
import { instagramRevenue } from '@/lib/instagram/revenue';

export async function GET(request: Request) {
  return analyticsReport(request, 'viewer', async ({ tx, accountId, range, params }) => {
    const by = parseFunnelBy(params.get('by'));
    const funnel = await commentFunnel(tx, accountId, range, by);
    const ctr: Record<string, number | null> = {};
    if (by === 'flow') {
      const ids = funnel.rows.map((row) => row.id).filter((id): id is string => !!id);
      const stats = await flowLinkStats(tx, accountId, ids, range.from, range.to);
      for (const id of ids) ctr[id] = clickThroughRate(stats.get(id));
    }
    const contacts = await instagramContactSeries(tx, accountId, range);
    const revenue = await instagramRevenue(tx, accountId, range, contacts.at(-1)?.total ?? 0);
    const conversions = await conversionCounts(tx, accountId, range, 'instagram');
    return { by, funnel, ctr, contacts, revenue, conversions };
  });
}
