// GET /api/analytics/attention?channel=&number=
// The Overview's "Needs attention" counts (viewer and above): open chats with
// no owner, unread chats, WhatsApp reply windows closing or closed, messages
// that failed today, and automations switched off. Live state, not a range;
// counts and automation names only.

import { analyticsReport } from '@/lib/analytics/http';
import { insightFilters } from '@/lib/analytics/insight-filters';
import { attentionCounts } from '@/lib/analytics/insights';

export async function GET(request: Request) {
  return analyticsReport(request, 'viewer', async ({ tx, accountId, range, params }) => ({
    attention: await attentionCounts(tx, accountId, range.timezone, insightFilters(params)),
  }));
}
