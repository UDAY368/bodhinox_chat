// GET /api/analytics/ai?preset=&from=&to=
// AI agent replies, handoffs and resolution rate. Agent role and above:
// unanswered questions are RLS-hidden from viewers, so a viewer would see a
// misleading zero.

import { analyticsReport } from '@/lib/analytics/http';
import { aiStats } from '@/lib/analytics/queries';

export async function GET(request: Request) {
  return analyticsReport(request, 'agent', async ({ tx, accountId, range }) => ({
    stats: await aiStats(tx, accountId, range),
  }));
}
