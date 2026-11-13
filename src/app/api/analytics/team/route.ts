// GET /api/analytics/team?preset=&from=&to=&channel=&number=[&member=<userId>]
// The Team tab (viewer and above). Without `member`: every member of the
// workspace with their figures for the range and the previous period, and live
// presence. With `member`: that member's figures over time and by channel
// (404 when they are not a member of this workspace). Names, roles, presence
// and counts only; no email or customer data.

import { analyticsReport, previousRange, rangeSummary } from '@/lib/analytics/http';
import { insightFilters } from '@/lib/analytics/insight-filters';
import { memberDetail, teamStats } from '@/lib/analytics/insights';
import { AnalyticsInputError } from '@/lib/analytics/queries';
import { AuthError } from '@/lib/auth/errors';

export async function GET(request: Request) {
  return analyticsReport(request, 'viewer', async ({ tx, accountId, range, params }) => {
    const filters = insightFilters(params);
    const member = params.get('member');
    if (member) {
      if (member.length > 64) throw new AnalyticsInputError('Invalid member');
      const detail = await memberDetail(tx, accountId, range, member, filters);
      if (!detail) throw new AuthError('Not found', 404, 'not_found');
      return { detail };
    }
    const previous = previousRange(range);
    return {
      previousRange: rangeSummary(previous),
      members: await teamStats(tx, accountId, range, filters),
      previous: await teamStats(tx, accountId, previous, filters),
    };
  });
}
