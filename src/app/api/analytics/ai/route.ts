// GET /api/analytics/ai?preset=&from=&to=
// AI agent replies, handoffs and resolution rate. Agent role and above:
// unanswered questions are RLS-hidden from viewers, so a viewer would see a
// misleading zero. Admins also get the estimated AI cost (tokens x list price,
// src/lib/analytics/ai-cost.ts); token usage is billing-class and RLS keeps it
// from other roles, so for them `cost` is null rather than a false zero.

import { analyticsReport } from '@/lib/analytics/http';
import { aiStats } from '@/lib/analytics/queries';
import { aiUsageTotals, estimateAiCost } from '@/lib/analytics/ai-cost';
import { hasMinRole } from '@/lib/auth/roles';

export async function GET(request: Request) {
  return analyticsReport(request, 'agent', async ({ tx, accountId, range, role }) => ({
    stats: await aiStats(tx, accountId, range),
    cost: hasMinRole(role, 'admin') ? estimateAiCost(await aiUsageTotals(tx, accountId, range)) : null,
  }));
}
