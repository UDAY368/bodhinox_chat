// Deal stages as conversion events (ads phase 4). When a workspace turns on
// "Send deal stages to Meta" (Settings > Ads, capi_deal_events), an hourly
// sweep reports each deal opened in the last two days as a QualifiedLead and each deal
// won in the last two days as a Purchase worth the deal's value. Deals are
// edited through the generic data API, so a sweep finds them instead of a
// hook on that path. Each event goes through the Conversions API pipeline
// (queueConversionEventTx): it needs an attributable ad click within 7 days
// and is keyed deal:<id>:<event>, so a deal is reported at most once per event
// however many sweeps see it.

import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { queueConversionEventTx } from './capi';

/** How far back each hourly sweep looks (a missed hour or two is caught up). */
export const DEAL_LOOKBACK_HOURS = 48;
/** Deals one sweep reports at most (the next sweep continues). */
export const DEAL_BATCH = 500;

export async function handleDealEventsJob(accountId: string, now: Date = new Date()): Promise<{ leads: number; purchases: number }> {
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    const [conn] = await tx.$queryRaw<{ on: boolean }[]>`SELECT capi_enabled AND capi_deal_events AS on FROM meta_ad_connections
      WHERE account_id=${accountId}::uuid AND status='active' LIMIT 1`;
    if (!conn?.on) return { leads: 0, purchases: 0 };
    const since = new Date(now.getTime() - DEAL_LOOKBACK_HOURS * 3_600_000);
    const deals = await tx.$queryRaw<{ id: string; contact_id: string; status: string; value: string | null; currency: string | null;
      created_at: Date; updated_at: Date }[]>`
      SELECT d.id::text AS id, d.contact_id::text AS contact_id, d.status, d.value::text AS value, d.currency, d.created_at, d.updated_at
      FROM deals d
      WHERE d.account_id=${accountId}::uuid AND d.contact_id IS NOT NULL
        AND (d.created_at >= ${since} OR (d.status='won' AND d.updated_at >= ${since}))
        AND EXISTS (SELECT 1 FROM ad_referrals r WHERE r.account_id=d.account_id AND r.contact_id=d.contact_id AND r.source_type='ad')
      ORDER BY d.updated_at DESC LIMIT ${DEAL_BATCH}`;
    let leads = 0, purchases = 0;
    for (const deal of deals) {
      if (deal.created_at >= since && await queueConversionEventTx(tx, {
        accountId, eventName: 'QualifiedLead', source: 'deal', sourceId: deal.id, contactId: deal.contact_id, eventTime: deal.created_at,
      })) leads++;
      if (deal.status === 'won' && await queueConversionEventTx(tx, {
        accountId, eventName: 'Purchase', source: 'deal', sourceId: deal.id, contactId: deal.contact_id,
        value: deal.value === null ? null : Number(deal.value), currency: deal.currency, eventTime: deal.updated_at,
      })) purchases++;
    }
    return { leads, purchases };
  }, getWorkerPrisma());
}
