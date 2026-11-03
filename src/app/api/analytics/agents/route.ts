// GET /api/analytics/agents?preset=&from=&to=
// Per-member leaderboard for the range (viewer and above). Rows carry the
// member's name, role and counts only; no customer data.

import { analyticsReport } from '@/lib/analytics/http';
import { agentLeaderboard } from '@/lib/analytics/queries';

export async function GET(request: Request) {
  return analyticsReport(request, 'viewer', async ({ tx, accountId, range }) => ({
    agents: await agentLeaderboard(tx, accountId, range),
  }));
}
