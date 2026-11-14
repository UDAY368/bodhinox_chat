// The Ads Overview (ads module, part B): totals, a daily trend, the split by
// platform (Facebook, Instagram, Messenger, Audience Network, WhatsApp,
// Threads) and the top campaigns for a range, over one linked ad account or
// all of them. Reads stored rows only, in the member's tenant scope; never
// calls Meta. Rates (CTR, CPM, cost per result) are left to the browser so a
// zero denominator stays "no value" rather than a fake 0.
import { Prisma } from '@prisma/client';
import { withTenant } from '@/lib/db/tenant';
import { workspaceTimezone } from '@/lib/analytics/range';
import type { MetaAdsActor } from './connection';
import { AD_PLATFORMS, type AdPlatform } from './graph';
import { reachPresetFor, type AdsQuery } from './insights';

export interface MetricTotals {
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  conversationsStarted: number;
  leads: number;
  metaPurchases: number;
}

export interface AdsOverview {
  /** Spend per currency: linked ad accounts may bill in different currencies. */
  spendByCurrency: { currency: string | null; spend: number }[];
  totals: MetricTotals;
  /** Unique people and frequency, only for Meta's fixed ranges (7, 30, 90 days to yesterday). */
  reach: number | null;
  frequency: number | null;
  /** Chats Bodhinox saw start from ads in the range (no Meta figure involved). */
  conversationsInBodhinox: number;
  daily: ({ day: string } & MetricTotals)[];
  platforms: ({ platform: AdPlatform } & Omit<MetricTotals, 'metaPurchases'>)[];
  topCampaigns: { id: string; name: string | null; objective: string | null; currency: string | null; spend: number; conversationsStarted: number; leads: number; linkClicks: number }[];
  insightsSyncedAt: string | null;
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const n = (value: unknown) => (value == null ? 0 : Number(value));

type Sums = { spend: unknown; impressions: unknown; clicks: unknown; link_clicks: unknown; conversations_started: unknown; leads: unknown; purchases?: unknown };
const totalsOf = (r: Sums | undefined): MetricTotals => ({
  spend: Math.round(n(r?.spend) * 100) / 100,
  impressions: n(r?.impressions),
  clicks: n(r?.clicks),
  linkClicks: n(r?.link_clicks),
  conversationsStarted: n(r?.conversations_started),
  leads: n(r?.leads),
  metaPurchases: n(r?.purchases),
});

export async function getAdsOverview(actor: MetaAdsActor, query: Omit<AdsQuery, 'level'>, now: number = Date.now()): Promise<AdsOverview> {
  const { accountId } = actor;
  const adAccountId = query.adAccountId ?? null;
  const preset = reachPresetFor(query.from, query.to, now);
  const scope = (alias: string) => Prisma.sql`${Prisma.raw(alias)}.account_id=${accountId}::uuid
    AND ${Prisma.raw(alias)}.day BETWEEN ${query.from}::date AND ${query.to}::date
    ${adAccountId ? Prisma.sql`AND ${Prisma.raw(alias)}.ad_account_id = ${adAccountId}` : Prisma.empty}`;
  return withTenant({ accountId, userId: actor.userId, role: actor.role }, async (tx) => {
    const tz = await workspaceTimezone(tx, accountId);
    const [byCurrency, [totals], daily, platforms, top, [reach], [chats], [synced]] = await Promise.all([
      tx.$queryRaw<{ currency: string | null; spend: unknown }[]>`SELECT i.currency, sum(i.spend) AS spend FROM meta_ad_insights i
        WHERE i.level='campaign' AND ${scope('i')} GROUP BY i.currency ORDER BY sum(i.spend) DESC`,
      tx.$queryRaw<Sums[]>`SELECT sum(i.spend) AS spend, sum(i.impressions) AS impressions, sum(i.clicks) AS clicks,
          sum(i.link_clicks) AS link_clicks, sum(i.conversations_started) AS conversations_started, sum(i.leads) AS leads,
          sum(i.purchases) AS purchases
        FROM meta_ad_insights i WHERE i.level='campaign' AND ${scope('i')}`,
      tx.$queryRaw<(Sums & { day: Date })[]>`SELECT i.day, sum(i.spend) AS spend, sum(i.impressions) AS impressions,
          sum(i.clicks) AS clicks, sum(i.link_clicks) AS link_clicks, sum(i.conversations_started) AS conversations_started,
          sum(i.leads) AS leads, sum(i.purchases) AS purchases
        FROM meta_ad_insights i WHERE i.level='campaign' AND ${scope('i')} GROUP BY i.day ORDER BY i.day`,
      tx.$queryRaw<(Sums & { platform: AdPlatform })[]>`SELECT p.platform, sum(p.spend) AS spend, sum(p.impressions) AS impressions,
          sum(p.clicks) AS clicks, sum(p.link_clicks) AS link_clicks, sum(p.conversations_started) AS conversations_started,
          sum(p.leads) AS leads
        FROM meta_ad_insight_platforms p WHERE ${scope('p')} GROUP BY p.platform`,
      tx.$queryRaw<(Sums & { id: string; name: string | null; objective: string | null; currency: string | null })[]>`
        SELECT i.object_id AS id, (array_agg(i.name ORDER BY i.day DESC))[1] AS name, max(i.objective) AS objective,
          max(i.currency) AS currency, sum(i.spend) AS spend, sum(i.conversations_started) AS conversations_started,
          sum(i.leads) AS leads, sum(i.link_clicks) AS link_clicks, 0 AS impressions, 0 AS clicks
        FROM meta_ad_insights i WHERE i.level='campaign' AND ${scope('i')}
        GROUP BY i.object_id ORDER BY sum(i.spend) DESC, i.object_id LIMIT 5`,
      preset
        // Reach is unique people, so it cannot be added across ad accounts: shown for one account only.
        ? tx.$queryRaw<{ reach: unknown; frequency: unknown }[]>`SELECT CASE WHEN count(*) = 1 THEN max(reach) END AS reach,
            CASE WHEN count(*) = 1 THEN max(frequency) END AS frequency
          FROM meta_ad_reach WHERE account_id=${accountId}::uuid AND level='account' AND preset=${preset}
            ${adAccountId ? Prisma.sql`AND ad_account_id = ${adAccountId}`
              : Prisma.sql`AND (SELECT count(*) FROM meta_ad_accounts a WHERE a.account_id=${accountId}::uuid) = 1`}`
        : Promise.resolve([{ reach: null, frequency: null }]),
      tx.$queryRaw<{ n: unknown }[]>`SELECT count(DISTINCT coalesce(r.conversation_id::text, r.id::text)) AS n FROM ad_referrals r
        WHERE r.account_id=${accountId}::uuid AND r.source_type='ad'
          AND r.created_at >= (${query.from}::date::timestamp AT TIME ZONE ${tz})
          AND r.created_at < ((${query.to}::date + 1)::timestamp AT TIME ZONE ${tz})
          ${adAccountId ? Prisma.sql`AND r.source_id IN (SELECT object_id FROM meta_ad_objects WHERE account_id=${accountId}::uuid
            AND level='ad' AND ad_account_id=${adAccountId})` : Prisma.empty}`,
      tx.$queryRaw<{ at: Date | null }[]>`SELECT insights_synced_at AS at FROM meta_ad_connections
        WHERE account_id=${accountId}::uuid AND status<>'disconnected' LIMIT 1`,
    ]);
    // Every day of the range, zeros where nothing was stored, so the chart's axis is even.
    const byDay = new Map(daily.map((d) => [isoDay(new Date(d.day).getTime()), d]));
    const days: string[] = [];
    for (let t = Date.parse(`${query.from}T00:00:00Z`); t <= Date.parse(`${query.to}T00:00:00Z`); t += DAY_MS) days.push(isoDay(t));
    const platformRows = new Map(platforms.map((p) => [p.platform, p]));
    return {
      spendByCurrency: byCurrency.map((c) => ({ currency: c.currency, spend: Math.round(n(c.spend) * 100) / 100 })),
      totals: totalsOf(totals),
      reach: reach?.reach == null ? null : n(reach.reach),
      frequency: reach?.frequency == null ? null : n(reach.frequency),
      conversationsInBodhinox: n(chats?.n),
      daily: days.map((day) => ({ day, ...totalsOf(byDay.get(day)) })),
      platforms: AD_PLATFORMS.filter((p) => platformRows.has(p)).map((platform) => {
        const { metaPurchases: _drop, ...rest } = totalsOf(platformRows.get(platform));
        void _drop;
        return { platform, ...rest };
      }),
      topCampaigns: top.map((c) => ({
        id: c.id, name: c.name, objective: c.objective, currency: c.currency, spend: Math.round(n(c.spend) * 100) / 100,
        conversationsStarted: n(c.conversations_started), leads: n(c.leads), linkClicks: n(c.link_clicks),
      })),
      insightsSyncedAt: synced?.at?.toISOString() ?? null,
    };
  });
}
