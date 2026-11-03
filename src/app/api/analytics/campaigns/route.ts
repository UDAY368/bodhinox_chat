// GET /api/analytics/campaigns?preset=&from=&to=[&broadcast=<id>]
// Campaign funnel for campaigns in the range, or for one campaign
// (viewer and above). Counts only; no recipient numbers.

import { analyticsReport } from '@/lib/analytics/http';
import { campaignFunnel } from '@/lib/analytics/queries';

export async function GET(request: Request) {
  return analyticsReport(request, 'viewer', async ({ tx, accountId, range, params }) => {
    const broadcastId = params.get('broadcast');
    return { funnel: await campaignFunnel(tx, accountId, broadcastId ? { broadcastId } : { range }) };
  });
}
