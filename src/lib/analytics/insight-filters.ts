// Query-string filters shared by the analytics redesign routes:
// ?channel=whatsapp|instagram and ?number=<whatsapp_config id>. Invalid values
// are refused by assertFilters (AnalyticsInputError, a 400 in analyticsReport).
import { assertFilters, type InsightFilters } from './insights';

export function insightFilters(params: URLSearchParams): InsightFilters {
  const filters: InsightFilters = {
    channel: (params.get('channel') || null) as InsightFilters['channel'],
    whatsappConfigId: params.get('number') || null,
  };
  // A WhatsApp number only scopes WhatsApp conversations.
  if (filters.channel === 'instagram') filters.whatsappConfigId = null;
  assertFilters(filters);
  return filters;
}
