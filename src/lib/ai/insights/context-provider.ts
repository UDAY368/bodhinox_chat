// The 'insightData' context provider: one fixed insight query's numbers for
// staff. Read-only; the insight key must be one of INSIGHT_KEYS and the
// requester's role must reach that insight's minimum. Only numbers and row
// labels ("Agent 1".."Agent n") are returned; agent names never leave here.

import { ANALYTICS_STATEMENT_TIMEOUT_MS } from '@/lib/analytics/queries';
import { parseRange, workspaceTimezone } from '@/lib/analytics/range';
import { emptyContext, type ContextProvider } from '../context-providers/core';
import { withRequestTenant } from '../context-providers/scope';
import { computeInsight, insightAllowed, isInsightKey } from './registry';

export const insightDataProvider: ContextProvider = {
  key: 'insightData',
  minRole: 'agent',
  audiences: ['staff'],
  load: async (request) => {
    const insight = request.insight;
    if (!insight || !isInsightKey(insight.key) || !insightAllowed(request.role, insight.key)) return emptyContext();
    const key = insight.key;
    return withRequestTenant(request, async (tx) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(ANALYTICS_STATEMENT_TIMEOUT_MS)}, true)`;
      const timezone = await workspaceTimezone(tx, request.accountId);
      const range = parseRange({ preset: 'custom', from: insight.from, to: insight.to, bucket: 'day' }, timezone);
      const computed = await computeInsight(tx, request.accountId, key, range);
      const out = emptyContext();
      out.facts.insight_key = key;
      out.facts.row_count = computed.rowCount;
      if (computed.currency !== undefined) out.facts.currency = computed.currency;
      for (const [name, value] of Object.entries(computed.metrics)) out.facts[`metric.${name}`] = value;
      for (const row of computed.rows ?? []) {
        for (const [name, value] of Object.entries(row.values)) out.facts[`row.${row.label}.${name}`] = value;
      }
      return out;
    });
  },
};
