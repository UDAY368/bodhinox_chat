// GET /api/analytics/trends?preset=&from=&to=&channel=&number=
// The Overview and Conversations tabs' charts (viewer and above): new and
// resolved conversations and first-response medians over time (by hour for
// one day, by day, or by week past 90 days), busiest hours, the channel split,
// conversations by label, the resolution-time spread and message totals, plus
// the previous period's message totals for the deltas. Counts, durations and
// workspace label names only.

import { analyticsReport, previousRange, rangeSummary } from '@/lib/analytics/http';
import { insightFilters } from '@/lib/analytics/insight-filters';
import { messageTotals, trendReport } from '@/lib/analytics/insights';

export async function GET(request: Request) {
  return analyticsReport(request, 'viewer', async ({ tx, accountId, range, params }) => {
    const filters = insightFilters(params);
    const previous = previousRange(range);
    return {
      previousRange: rangeSummary(previous),
      trend: await trendReport(tx, accountId, range, filters),
      previousMessages: await messageTotals(tx, accountId, previous, filters),
    };
  });
}
