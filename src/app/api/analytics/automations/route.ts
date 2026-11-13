// GET /api/analytics/automations?preset=&from=&to=&channel=
// The Campaigns tab's automation figures (viewer and above): runs per flow,
// rule and sequence in the range (busiest 50) with a click rate for flows
// that show tracked links, runs by kind, and the previous period's total.
// Automation names and counts only.

import { analyticsReport, previousRange } from '@/lib/analytics/http';
import { insightFilters } from '@/lib/analytics/insight-filters';
import { automationStats } from '@/lib/analytics/insights';

export async function GET(request: Request) {
  return analyticsReport(request, 'viewer', async ({ tx, accountId, range, params }) => {
    const filters = insightFilters(params);
    const current = await automationStats(tx, accountId, range, filters);
    const before = await automationStats(tx, accountId, previousRange(range), filters);
    return { automations: current, previousTotal: before.total };
  });
}
