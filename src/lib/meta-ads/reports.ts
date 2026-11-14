// Ads reports (phase 2): splits by age and gender, region, device or
// placement (read live from Meta with the stored login, cached briefly), Meta's
// own preview of an existing ad, chat quality per ad (chats, replies, deals
// and won deals from Bodhinox's own records), and the campaign rows of the
// scheduled "Ads summary" report.
//
// Every Meta read is for an ad account linked to the workspace, or an object
// already stored for it, so a member can never read another account's ads
// through the workspace's login. Chat quality runs in the member's own tenant
// scope (row-level security decides which deals they see).

import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import type { AnalyticsRange } from '@/lib/analytics/range';
import { workspaceTimezone } from '@/lib/analytics/range';
import { loadActiveConnectionTx, MetaAdsError, type MetaAdsActor } from './connection';
import {
  getAdPreview, getBreakdownInsights, INSIGHT_BREAKDOWNS, isMetaThrottle, isMetaTokenInvalid, metaErrorCode,
  PREVIEW_FORMATS, type InsightBreakdown, type MetaBreakdownRow, type PreviewFormat,
} from './graph';
import { attributedPaymentsSql, MAX_RANGE_DAYS } from './insights';
import { isCurrencyCode, minorToDecimalString } from '@/lib/commerce/money';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const META_ID = /^\d{1,32}$/;
const DAY_MS = 86_400_000;

const worker = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>, userId?: string) =>
  withTenant({ accountId, userId, role: 'owner' }, work, getWorkerPrisma());

/** A YYYY-MM-DD range no longer than the stored reports allow, ending no later than today. */
function parseRange(params: URLSearchParams, now: number): { from: string; to: string } | null {
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  if (!DAY.test(from) || !DAY.test(to)) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return null;
  if ((b - a) / DAY_MS + 1 > MAX_RANGE_DAYS || b > now + DAY_MS) return null;
  return { from, to };
}

const optionalId = (value: string | null): string | null | undefined =>
  value === null || value === '' ? null : META_ID.test(value) ? value : undefined;

// ---------------------------------------------------------------- breakdowns

export interface BreakdownQuery { from: string; to: string; adAccountId: string | null; objectId: string | null; breakdown: InsightBreakdown }

export function parseBreakdownQuery(params: URLSearchParams, now: number = Date.now()): BreakdownQuery | null {
  const range = parseRange(params, now);
  const breakdown = params.get('breakdown') as InsightBreakdown;
  const adAccountId = optionalId(params.get('adAccountId'));
  const objectId = optionalId(params.get('objectId'));
  if (!range || !INSIGHT_BREAKDOWNS.includes(breakdown) || adAccountId === undefined || objectId === undefined) return null;
  return { ...range, adAccountId, objectId, breakdown };
}

export interface BreakdownResult { currency: string | null; rows: MetaBreakdownRow[] }

// shortcut: per-process cache, so each web instance asks Meta at most once per 15 minutes per view; move to a shared store if Meta's rate limits start biting.
const CACHE_MS = 15 * 60_000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; value: BreakdownResult }>();
const MAX_ROWS = 200;

/** Maps a Meta failure to the module's errors (the token and Meta's message are never logged). */
function metaFailure(error: unknown, what: string): never {
  console.error(`[meta-ads] ${what} failed`, metaErrorCode(error) ?? (error instanceof Error ? error.name : 'unknown'));
  if (isMetaTokenInvalid(error)) throw new MetaAdsError('token_invalid');
  if (isMetaThrottle(error)) throw new MetaAdsError('rate_limited');
  throw new MetaAdsError('meta_error');
}

export async function getBreakdowns(actor: MetaAdsActor, query: BreakdownQuery, now: number = Date.now()): Promise<BreakdownResult> {
  const { token, target, currency } = await worker(actor.accountId, async (tx) => {
    const conn = await loadActiveConnectionTx(tx, actor.accountId);
    if (!conn?.userToken) throw new MetaAdsError('not_connected');
    if (query.objectId) {
      const [object] = await tx.$queryRaw<{ ad_account_id: string; currency: string | null }[]>`
        SELECT o.ad_account_id, a.currency FROM meta_ad_objects o
        JOIN meta_ad_accounts a ON a.account_id=o.account_id AND a.ad_account_id=o.ad_account_id
        WHERE o.account_id=${actor.accountId}::uuid AND o.object_id=${query.objectId}
          ${query.adAccountId ? Prisma.sql`AND o.ad_account_id=${query.adAccountId}` : Prisma.empty}
        LIMIT 1`;
      if (!object) throw new MetaAdsError('not_found');
      return { token: conn.userToken, target: { objectId: query.objectId } as const, currency: object.currency };
    }
    const [account] = await tx.$queryRaw<{ ad_account_id: string; currency: string | null }[]>`
      SELECT ad_account_id, currency FROM meta_ad_accounts WHERE account_id=${actor.accountId}::uuid
        AND ${query.adAccountId ? Prisma.sql`ad_account_id=${query.adAccountId}` : Prisma.sql`is_primary`}
      LIMIT 1`;
    if (!account) throw new MetaAdsError(query.adAccountId ? 'not_found' : 'not_connected');
    return { token: conn.userToken, target: { adAccountId: account.ad_account_id } as const, currency: account.currency };
  }, actor.userId);

  const key = `${actor.accountId}|${JSON.stringify(target)}|${query.from}|${query.to}|${query.breakdown}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  let rows: MetaBreakdownRow[];
  try {
    rows = await getBreakdownInsights(target, token, { since: query.from, until: query.to, breakdown: query.breakdown });
  } catch (error) {
    metaFailure(error, 'breakdown read');
  }
  const value: BreakdownResult = {
    currency,
    rows: rows.filter((r) => r.impressions > 0 || r.spend > 0).sort((a, b) => b.spend - a.spend || b.impressions - a.impressions).slice(0, MAX_ROWS),
  };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: now, value });
  return value;
}

/** Test hook: forget cached breakdowns. */
export function clearBreakdownCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------- ad preview

export function parsePreviewQuery(params: URLSearchParams): { adId: string; format: PreviewFormat } | null {
  const adId = params.get('adId') ?? '';
  const format = (params.get('format') ?? 'MOBILE_FEED_STANDARD') as PreviewFormat;
  return META_ID.test(adId) && PREVIEW_FORMATS.includes(format) ? { adId, format } : null;
}

/** Meta's preview of a stored ad of this workspace, as the address of Meta's preview page. */
export async function getStoredAdPreview(actor: MetaAdsActor, adId: string, format: PreviewFormat): Promise<{ src: string | null }> {
  const token = await worker(actor.accountId, async (tx) => {
    const conn = await loadActiveConnectionTx(tx, actor.accountId);
    if (!conn?.userToken) throw new MetaAdsError('not_connected');
    const [known] = await tx.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok FROM meta_ad_objects
      WHERE account_id=${actor.accountId}::uuid AND level='ad' AND object_id=${adId}
      UNION ALL SELECT 1 FROM meta_ad_insights WHERE account_id=${actor.accountId}::uuid AND level='ad' AND object_id=${adId}
      LIMIT 1`;
    if (!known) throw new MetaAdsError('not_found');
    return conn.userToken;
  }, actor.userId);
  try {
    return { src: await getAdPreview(adId, token, format) };
  } catch (error) {
    metaFailure(error, 'ad preview');
  }
}

// ---------------------------------------------------------------- chat quality per ad

export interface ChatQualityRow {
  adId: string;
  name: string | null;
  currency: string | null;
  spend: number;
  /** Chats Bodhinox saw start from the ad in the range. */
  chats: number;
  /** Of those, chats your team or a bot answered. */
  replied: number;
  /** Deals opened for those contacts after their ad click. */
  deals: number;
  won: number;
}

export function parseQualityQuery(params: URLSearchParams, now: number = Date.now()): { from: string; to: string; adAccountId: string | null } | null {
  const range = parseRange(params, now);
  const adAccountId = optionalId(params.get('adAccountId'));
  return range && adAccountId !== undefined ? { ...range, adAccountId } : null;
}

const n = (value: unknown) => (value == null ? 0 : Number(value));

export async function chatQuality(actor: MetaAdsActor, query: { from: string; to: string; adAccountId: string | null }): Promise<ChatQualityRow[]> {
  const { accountId } = actor;
  return withTenant({ accountId, userId: actor.userId, role: actor.role }, async (tx) => {
    const tz = await workspaceTimezone(tx, accountId);
    const start = Prisma.sql`(${query.from}::date::timestamp AT TIME ZONE ${tz})`;
    const end = Prisma.sql`((${query.to}::date + 1)::timestamp AT TIME ZONE ${tz})`;
    const accountFilter = (column: Prisma.Sql) => (query.adAccountId
      ? Prisma.sql`AND ${column} IN (SELECT object_id FROM meta_ad_objects WHERE account_id=${accountId}::uuid AND level='ad' AND ad_account_id=${query.adAccountId})`
      : Prisma.empty);
    const rows = await tx.$queryRaw<{ ad_id: string; name: string | null; currency: string | null; spend: unknown; chats: unknown; replied: unknown; deals: unknown; won: unknown }[]>`
      WITH refs AS (
        SELECT r.source_id AS ad_id, r.contact_id, r.conversation_id, min(r.created_at) AS first_at
        FROM ad_referrals r
        WHERE r.account_id=${accountId}::uuid AND r.source_type='ad' AND r.source_id IS NOT NULL
          AND r.created_at >= ${start} AND r.created_at < ${end} ${accountFilter(Prisma.sql`r.source_id`)}
        GROUP BY r.source_id, r.contact_id, r.conversation_id
      ), quality AS (
        SELECT f.ad_id,
          count(DISTINCT coalesce(f.conversation_id::text, f.contact_id::text)) AS chats,
          count(DISTINCT f.conversation_id) FILTER (WHERE EXISTS (
            SELECT 1 FROM messages m WHERE m.account_id=${accountId}::uuid AND m.conversation_id=f.conversation_id
              AND m.sender_type IN ('agent','bot') AND m.created_at >= f.first_at)) AS replied,
          count(DISTINCT d.id) AS deals,
          count(DISTINCT d.id) FILTER (WHERE d.status='won') AS won
        FROM refs f
        LEFT JOIN deals d ON d.account_id=${accountId}::uuid AND d.contact_id=f.contact_id AND d.created_at >= f.first_at
        GROUP BY f.ad_id
      ), spend AS (
        SELECT i.object_id AS ad_id, (array_agg(i.name ORDER BY i.day DESC))[1] AS name, max(i.currency) AS currency, sum(i.spend) AS spend
        FROM meta_ad_insights i
        WHERE i.account_id=${accountId}::uuid AND i.level='ad' AND i.day BETWEEN ${query.from}::date AND ${query.to}::date
          ${query.adAccountId ? Prisma.sql`AND i.ad_account_id=${query.adAccountId}` : Prisma.empty}
        GROUP BY i.object_id
      )
      SELECT coalesce(q.ad_id, s.ad_id) AS ad_id, s.name, s.currency, coalesce(s.spend, 0) AS spend,
        coalesce(q.chats, 0) AS chats, coalesce(q.replied, 0) AS replied, coalesce(q.deals, 0) AS deals, coalesce(q.won, 0) AS won
      FROM quality q FULL JOIN spend s ON s.ad_id = q.ad_id
      ORDER BY coalesce(q.chats, 0) DESC, coalesce(s.spend, 0) DESC, 1
      LIMIT 200`;
    return rows.map((r) => ({
      adId: r.ad_id, name: r.name, currency: r.currency, spend: Math.round(n(r.spend) * 100) / 100,
      chats: n(r.chats), replied: n(r.replied), deals: n(r.deals), won: n(r.won),
    }));
  });
}

// ---------------------------------------------------------------- scheduled "Ads summary" report

export interface AdsReportRow {
  adAccountId: string;
  campaignId: string;
  campaign: string | null;
  currency: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  chatsStarted: number;
  leads: number;
  chatsInBodhinox: number;
  revenue: string | null;
  sales: number;
}

/** One row per campaign that spent or brought chats in the report's range (any tenant transaction of the workspace). */
export async function adsReportRows(tx: TenantTransaction, accountId: string, range: AnalyticsRange): Promise<AdsReportRow[]> {
  const from = range.from.toISOString();
  const to = range.to.toISOString();
  const start = Prisma.sql`${from}::timestamptz`;
  const end = Prisma.sql`${to}::timestamptz`;
  const rows = await tx.$queryRaw<{
    ad_account_id: string; campaign_id: string; name: string | null; currency: string | null; spend: unknown; impressions: unknown;
    clicks: unknown; link_clicks: unknown; chats_started: unknown; leads: unknown; chats: unknown; minor: unknown; sales: unknown; pay_currency: string | null;
  }[]>`
    WITH c AS (
      SELECT i.ad_account_id, i.object_id AS campaign_id, (array_agg(i.name ORDER BY i.day DESC))[1] AS name, max(i.currency) AS currency,
        sum(i.spend) AS spend, sum(i.impressions) AS impressions, sum(i.clicks) AS clicks, sum(i.link_clicks) AS link_clicks,
        sum(i.conversations_started) AS chats_started, sum(i.leads) AS leads
      FROM meta_ad_insights i
      WHERE i.account_id=${accountId}::uuid AND i.level='campaign' AND i.day BETWEEN ${range.startDay}::date AND ${range.endDay}::date
      GROUP BY i.ad_account_id, i.object_id
    ), chats AS (
      SELECT o.campaign_id, count(DISTINCT coalesce(r.conversation_id::text, r.id::text)) AS chats
      FROM ad_referrals r JOIN meta_ad_objects o ON o.account_id=r.account_id AND o.level='ad' AND o.object_id=r.source_id
      WHERE r.account_id=${accountId}::uuid AND r.source_type='ad' AND r.created_at >= ${from}::timestamptz AND r.created_at < ${to}::timestamptz
      GROUP BY o.campaign_id
    ), pay AS (
      SELECT o.campaign_id, max(a.currency) AS currency, sum(a.minor) AS minor, count(*) AS sales
      FROM (${attributedPaymentsSql(accountId, start, end)}) a
      JOIN meta_ad_objects o ON o.account_id=${accountId}::uuid AND o.level='ad' AND o.object_id=a.source_id
      GROUP BY o.campaign_id HAVING count(DISTINCT a.currency) = 1
    )
    SELECT c.*, coalesce(ch.chats, 0) AS chats, p.minor, coalesce(p.sales, 0) AS sales, p.currency AS pay_currency
    FROM c LEFT JOIN chats ch ON ch.campaign_id=c.campaign_id LEFT JOIN pay p ON p.campaign_id=c.campaign_id
    ORDER BY c.spend DESC, c.campaign_id`;
  return rows.map((r) => ({
    adAccountId: r.ad_account_id, campaignId: r.campaign_id, campaign: r.name, currency: r.currency,
    spend: Math.round(n(r.spend) * 100) / 100, impressions: n(r.impressions), clicks: n(r.clicks), linkClicks: n(r.link_clicks),
    chatsStarted: n(r.chats_started), leads: n(r.leads), chatsInBodhinox: n(r.chats),
    revenue: r.minor != null && r.pay_currency && isCurrencyCode(r.pay_currency)
      ? `${minorToDecimalString(BigInt(String(r.minor)), r.pay_currency)} ${r.pay_currency}` : null,
    sales: n(r.sales),
  }));
}
