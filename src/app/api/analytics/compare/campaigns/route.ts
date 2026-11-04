// GET /api/analytics/compare/campaigns?ids=<uuid>,<uuid>[,...] (2 to 5 campaigns)
// Side-by-side funnels for the named campaigns, whatever their dates (viewer
// and above, as /api/analytics/campaigns). Counts only; no recipient numbers.
// Ids from another workspace match nothing (RLS plus the account filter).

import { analyticsReport } from '@/lib/analytics/http';
import { AnalyticsInputError, campaignFunnel, COMPARE_CAMPAIGNS_MAX } from '@/lib/analytics/queries';

export async function GET(request: Request) {
  return analyticsReport(request, 'viewer', async ({ tx, accountId, params }) => {
    const raw = params.get('ids') ?? '';
    // Bound the split before validating: a long list is refused, not parsed.
    if (raw.length > (COMPARE_CAMPAIGNS_MAX + 1) * 37) throw new AnalyticsInputError('Invalid campaigns');
    const ids = raw.split(',').map((id) => id.trim()).filter(Boolean);
    const funnel = await campaignFunnel(tx, accountId, { ids });
    return { campaigns: funnel.broadcasts };
  });
}
