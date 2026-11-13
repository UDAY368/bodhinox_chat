// GET /api/analytics/campaigns?preset=&from=&to=[&broadcast=<id>]
// Campaign funnel for campaigns in the range, or for one campaign
// (viewer and above). Counts only; no recipient numbers. For a range, also the
// previous period's totals and campaign count (the Campaigns tab's deltas).

import { analyticsReport, previousRange } from '@/lib/analytics/http';
import { campaignFunnel } from '@/lib/analytics/queries';

export async function GET(request: Request) {
  return analyticsReport(request, 'viewer', async ({ tx, accountId, range, params }) => {
    const broadcastId = params.get('broadcast');
    if (broadcastId) return { funnel: await campaignFunnel(tx, accountId, { broadcastId }) };
    const funnel = await campaignFunnel(tx, accountId, { range });
    const before = await campaignFunnel(tx, accountId, { range: previousRange(range) });
    return { funnel, previous: { totals: before.totals, count: before.broadcasts.length } };
  });
}
