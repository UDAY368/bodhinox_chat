// GET /api/analytics/instagram?preset=&from=&to=[&by=post|flow]
// Instagram › Insights: the comment funnel (comments, DMs, opened DMs, link
// clicks, leads, new followers) per post or per flow (viewer and above).
// Counts only; see src/lib/instagram/funnel.ts.

import { analyticsReport } from '@/lib/analytics/http';
import { commentFunnel, parseFunnelBy } from '@/lib/instagram/funnel';

export async function GET(request: Request) {
  return analyticsReport(request, 'viewer', async ({ tx, accountId, range, params }) => {
    const by = parseFunnelBy(params.get('by'));
    return { by, funnel: await commentFunnel(tx, accountId, range, by) };
  });
}
