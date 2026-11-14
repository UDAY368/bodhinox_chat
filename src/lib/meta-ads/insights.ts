// Campaign, ad set and ad insights (parts a and B).
//
// handleInsightsSyncJob (meta.insights_sync, worker) upserts daily campaign,
// ad set and ad rows, the per-platform split and reach for every linked ad
// account from the Marketing API: the last 7 days hourly, 90 days once a day.
// It finishes without a network call while the feature is off, when there is
// no active connection or when ads_read was not granted. Meta is called outside
// any transaction; an expired token marks the connection token_invalid and the
// job finishes; a throttle rethrows so the job retries.
//
// listAdsWithInsights (app role) reads stored rows only and adds what
// Bodhinox saw itself: conversations started from each ad (ad_referrals) and
// attributed Purchase events (capi_events).
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { workspaceTimezone } from '@/lib/analytics/range';
import { metaAdsConfig, missingScopes } from './config';
import { loadActiveConnectionTx, type MetaAdsActor } from './connection';
import {
  getInsights, getPlatformInsights, getReach, isMetaTokenInvalid, listCampaigns, metaErrorCode, REACH_PRESETS,
  type InsightLevel, type MetaInsightRow, type MetaPlatformRow, type MetaReachRow, type ReachLevel, type ReachPreset,
} from './graph';
import { syncedAdAccountsTx } from './accounts';

export const INSIGHTS_WINDOW_DAYS = 30;
/** The hourly sync refreshes the last week; the first sync of each day refreshes 90 days. */
export const HOURLY_SYNC_DAYS = 7;
export const FULL_SYNC_DAYS = 90;
/** Rows per upsert statement. */
const CHUNK = 500;
const DAY_MS = 86_400_000;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The [since, until] days (UTC) of the rolling window ending at `now`. */
export function insightsWindow(now: number = Date.now(), days: number = INSIGHTS_WINDOW_DAYS): { since: string; until: string } {
  return { since: isoDay(now - (days - 1) * DAY_MS), until: isoDay(now) };
}

const worker = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());

type StatusRow = MetaInsightRow & { status: string | null };

async function upsertInsightsTx(tx: TenantTransaction, accountId: string, connectionId: string, adAccountId: string, rows: StatusRow[]) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    await tx.$executeRaw`
      INSERT INTO meta_ad_insights(account_id, connection_id, ad_account_id, level, object_id, campaign_id, adset_id, name, status,
        objective, day, spend, currency, impressions, clicks, link_clicks, conversations_started, leads, purchases, synced_at)
      SELECT ${accountId}::uuid, ${connectionId}::uuid, ${adAccountId}, r.level, r.object_id, r.campaign_id, r.adset_id, r.name,
        r.status, r.objective, r.day, r.spend, r.currency, r.impressions, r.clicks, r.link_clicks, r.conversations_started, r.leads,
        r.purchases, now()
      FROM unnest(${part.map((r) => r.level)}::text[], ${part.map((r) => r.objectId)}::text[],
        ${part.map((r) => r.campaignId)}::text[], ${part.map((r) => r.adsetId)}::text[], ${part.map((r) => r.name)}::text[],
        ${part.map((r) => r.status)}::text[], ${part.map((r) => r.objective)}::text[], ${part.map((r) => r.day)}::date[],
        ${part.map((r) => r.spend)}::numeric[], ${part.map((r) => r.currency)}::text[], ${part.map((r) => r.impressions)}::bigint[],
        ${part.map((r) => r.clicks)}::bigint[], ${part.map((r) => r.linkClicks)}::bigint[],
        ${part.map((r) => r.conversationsStarted)}::bigint[], ${part.map((r) => r.leads)}::bigint[],
        ${part.map((r) => r.purchases)}::bigint[])
        AS r(level, object_id, campaign_id, adset_id, name, status, objective, day, spend, currency, impressions, clicks, link_clicks,
          conversations_started, leads, purchases)
      ON CONFLICT (account_id, level, object_id, day) DO UPDATE SET
        connection_id=EXCLUDED.connection_id, ad_account_id=EXCLUDED.ad_account_id, campaign_id=EXCLUDED.campaign_id,
        adset_id=EXCLUDED.adset_id, name=EXCLUDED.name, status=EXCLUDED.status, objective=EXCLUDED.objective,
        spend=EXCLUDED.spend, currency=EXCLUDED.currency, impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks,
        link_clicks=EXCLUDED.link_clicks, conversations_started=EXCLUDED.conversations_started, leads=EXCLUDED.leads,
        purchases=EXCLUDED.purchases, synced_at=now()`;
  }
}

async function upsertPlatformsTx(tx: TenantTransaction, accountId: string, connectionId: string, adAccountId: string, rows: MetaPlatformRow[]) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    await tx.$executeRaw`
      INSERT INTO meta_ad_insight_platforms(account_id, connection_id, ad_account_id, campaign_id, day, platform, spend,
        impressions, clicks, link_clicks, conversations_started, leads, synced_at)
      SELECT ${accountId}::uuid, ${connectionId}::uuid, ${adAccountId}, r.campaign_id, r.day, r.platform, r.spend, r.impressions,
        r.clicks, r.link_clicks, r.conversations_started, r.leads, now()
      FROM unnest(${part.map((r) => r.campaignId)}::text[], ${part.map((r) => r.day)}::date[], ${part.map((r) => r.platform)}::text[],
        ${part.map((r) => r.spend)}::numeric[], ${part.map((r) => r.impressions)}::bigint[], ${part.map((r) => r.clicks)}::bigint[],
        ${part.map((r) => r.linkClicks)}::bigint[], ${part.map((r) => r.conversationsStarted)}::bigint[],
        ${part.map((r) => r.leads)}::bigint[])
        AS r(campaign_id, day, platform, spend, impressions, clicks, link_clicks, conversations_started, leads)
      ON CONFLICT (account_id, campaign_id, day, platform) DO UPDATE SET
        connection_id=EXCLUDED.connection_id, ad_account_id=EXCLUDED.ad_account_id, spend=EXCLUDED.spend,
        impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks, link_clicks=EXCLUDED.link_clicks,
        conversations_started=EXCLUDED.conversations_started, leads=EXCLUDED.leads, synced_at=now()`;
  }
}

interface ReachBatch { level: ReachLevel; preset: ReachPreset; rows: MetaReachRow[] }

async function upsertReachTx(tx: TenantTransaction, accountId: string, connectionId: string, adAccountId: string, batches: ReachBatch[]) {
  for (const batch of batches) {
    for (let i = 0; i < batch.rows.length; i += CHUNK) {
      const part = batch.rows.slice(i, i + CHUNK);
      await tx.$executeRaw`
        INSERT INTO meta_ad_reach(account_id, connection_id, ad_account_id, level, object_id, preset, reach, frequency, synced_at)
        SELECT ${accountId}::uuid, ${connectionId}::uuid, ${adAccountId}, ${batch.level}, r.object_id, ${batch.preset}, r.reach,
          r.frequency, now()
        FROM unnest(${part.map((r) => r.objectId)}::text[], ${part.map((r) => r.reach)}::bigint[],
          ${part.map((r) => r.frequency)}::numeric[]) AS r(object_id, reach, frequency)
        ON CONFLICT (account_id, level, object_id, preset) DO UPDATE SET
          connection_id=EXCLUDED.connection_id, ad_account_id=EXCLUDED.ad_account_id, reach=EXCLUDED.reach,
          frequency=EXCLUDED.frequency, synced_at=now()`;
    }
  }
}

interface AccountData { rows: StatusRow[]; platforms: MetaPlatformRow[]; reach: ReachBatch[] }

/** Everything one ad account reports for the window. Meta only; no database. */
async function fetchAccount(adAccountId: string, token: string, window: { since: string; until: string }, reachLevels: ReachLevel[]): Promise<AccountData> {
  const [campaigns, campaignRows, adsetRows, adRows, platforms] = await Promise.all([
    listCampaigns(adAccountId, token),
    getInsights(adAccountId, token, { level: 'campaign', ...window }),
    getInsights(adAccountId, token, { level: 'adset', ...window }),
    getInsights(adAccountId, token, { level: 'ad', ...window }),
    getPlatformInsights(adAccountId, token, window),
  ]);
  const status = new Map(campaigns.map((c) => [c.id, c.status]));
  const reach: ReachBatch[] = [];
  // One range at a time keeps the burst of calls per ad account small.
  for (const level of reachLevels) {
    for (const preset of REACH_PRESETS) reach.push({ level, preset, rows: await getReach(adAccountId, token, level, preset) });
  }
  return {
    rows: [
      ...campaignRows.map((r) => ({ ...r, status: status.get(r.objectId) ?? null })),
      ...adsetRows.map((r) => ({ ...r, status: null })),
      ...adRows.map((r) => ({ ...r, status: null })),
    ],
    platforms,
    reach,
  };
}

/**
 * meta.insights_sync: daily rows (campaigns, ad sets, ads), the per-platform
 * split and reach for every linked ad account. The hourly run covers the last
 * HOURLY_SYNC_DAYS days and the campaign-level reach; a `full` run (once a
 * day, and when an ad account is added) covers FULL_SYNC_DAYS days and reach
 * at every level. One ad account failing does not stop the others; an invalid
 * token marks the connection and stops (the admin reconnects).
 */
export async function handleInsightsSyncJob(accountId: string, payload: Record<string, unknown>): Promise<void> {
  if (!metaAdsConfig()) return;
  const connection = await worker(accountId, (tx) => loadActiveConnectionTx(tx, accountId));
  if (!connection?.userToken) return;
  if (missingScopes(connection.scopes, 'insights').length) return;
  const { userToken } = connection;
  const adAccounts = await worker(accountId, (tx) => syncedAdAccountsTx(tx, accountId, connection));
  if (!adAccounts.length) return;
  const full = payload.full === true;
  const window = insightsWindow(Date.now(), full ? FULL_SYNC_DAYS : HOURLY_SYNC_DAYS);
  const reachLevels: ReachLevel[] = full ? ['account', 'campaign', 'adset', 'ad'] : ['account', 'campaign'];

  let synced = 0;
  let failure: unknown = null;
  for (const adAccountId of adAccounts) {
    let data: AccountData;
    try {
      data = await fetchAccount(adAccountId, userToken, window, reachLevels);
    } catch (error) {
      const code = metaErrorCode(error);
      console.error('[meta-ads] insights sync failed', code ?? (error instanceof Error ? error.name : 'unknown'));
      if (isMetaTokenInvalid(error)) {
        await worker(accountId, (tx) => tx.$executeRaw`UPDATE meta_ad_connections SET last_error_code=${code},
            status='token_invalid', updated_at=now()
          WHERE account_id=${accountId}::uuid AND id=${connection.id}::uuid AND status='active'`);
        // An invalid token cannot recover by retrying; the admin reconnects.
        return;
      }
      await worker(accountId, (tx) => tx.$executeRaw`UPDATE meta_ad_accounts SET last_error_code=${code}
        WHERE account_id=${accountId}::uuid AND ad_account_id=${adAccountId}`);
      failure = failure ?? error;
      continue;
    }
    const stored = await worker(accountId, async (tx) => {
      // Still the same active connection: a disconnect during the fetch wins.
      const live = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM meta_ad_connections
        WHERE account_id=${accountId}::uuid AND id=${connection.id}::uuid AND status='active' FOR UPDATE`;
      if (!live[0]) return false;
      await upsertInsightsTx(tx, accountId, connection.id, adAccountId, data.rows);
      await upsertPlatformsTx(tx, accountId, connection.id, adAccountId, data.platforms);
      await upsertReachTx(tx, accountId, connection.id, adAccountId, data.reach);
      await tx.$executeRaw`UPDATE meta_ad_accounts SET insights_synced_at=now(), last_error_code=NULL
        WHERE account_id=${accountId}::uuid AND ad_account_id=${adAccountId}`;
      return true;
    });
    if (!stored) return;
    synced++;
  }

  const code = failure ? metaErrorCode(failure) : null;
  await worker(accountId, (tx) => tx.$executeRaw`UPDATE meta_ad_connections SET
      insights_synced_at=CASE WHEN ${synced > 0} THEN now() ELSE insights_synced_at END,
      last_error_code=${code}, updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${connection.id}::uuid AND status='active'`);
  // Throttles and other failures retry (the job has maxAttempts 3).
  if (failure) throw failure;
}

export type AdsLevel = InsightLevel;

export interface AdsQuery {
  level: AdsLevel;
  /** Inclusive YYYY-MM-DD days. */
  from: string;
  to: string;
  /** One linked ad account, or null / absent for all of them. */
  adAccountId?: string | null;
}

export interface AdInsightSummary {
  id: string;
  adAccountId: string | null;
  campaignId: string | null;
  adsetId: string | null;
  name: string | null;
  status: string | null;
  objective: string | null;
  currency: string | null;
  /** Meta's figures; null when no insight row is stored for the range (unknown, not zero). */
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  linkClicks: number | null;
  conversationsStarted: number | null;
  leads: number | null;
  /** Purchases Meta attributes to the ad (pixel, app or on-Meta). */
  metaPurchases: number | null;
  /** Unique people reached and average frequency; only for Meta's fixed ranges (7, 30, 90 days to yesterday). */
  reach: number | null;
  frequency: number | null;
  /** Conversations Bodhinox saw start from this ad (or this campaign's or ad set's ads). */
  conversationsInBodhinox: number;
  /** Purchase conversion events attributed to clicks on this ad (or campaign / ad set). */
  purchases: number;
  /** Ads: the creative preview, from the last campaign sync. */
  thumbnailUrl: string | null;
}

export interface AdsWithInsights {
  rows: AdInsightSummary[];
  insightsSyncedAt: string | null;
  /** The reach range the query matched, or null (reach is then unknown). */
  reachPreset: ReachPreset | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The longest range the Ads table reads. */
export const MAX_RANGE_DAYS = 92;
const MAX_ROWS = 500;
const META_ID = /^\d{1,32}$/;

/**
 * Meta's fixed reach ranges end yesterday: last_7d is the 7 days before today.
 * A query covering exactly one of them can show reach; any other range cannot.
 */
export function reachPresetFor(from: string, to: string, now: number = Date.now()): ReachPreset | null {
  const yesterday = isoDay(now - DAY_MS);
  if (to !== yesterday) return null;
  for (const [preset, days] of [['last_7d', 7], ['last_30d', 30], ['last_90d', 90]] as const) {
    if (from === isoDay(now - days * DAY_MS)) return preset;
  }
  return null;
}

/** Validates a range: two real days, from <= to, at most MAX_RANGE_DAYS. Null when invalid. */
export function parseAdsQuery(params: URLSearchParams, now: number = Date.now()): AdsQuery | null {
  const level = params.get('level') ?? 'campaign';
  if (level !== 'campaign' && level !== 'adset' && level !== 'ad') return null;
  const account = params.get('adAccountId');
  const adAccountId = !account || account === 'all' ? null : account;
  if (adAccountId !== null && !META_ID.test(adAccountId)) return null;
  const fallback = insightsWindow(now);
  const from = params.get('from') || fallback.since;
  const to = params.get('to') || fallback.until;
  if (!DAY.test(from) || !DAY.test(to)) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || isoDay(a) !== from || isoDay(b) !== to) return null;
  if (b < a || (b - a) / DAY_MS + 1 > MAX_RANGE_DAYS) return null;
  return { level, from, to, adAccountId };
}

interface SummaryRow {
  id: string; ad_account_id: string | null; campaign_id: string | null; adset_id: string | null; name: string | null;
  status: string | null; objective: string | null; currency: string | null; spend: Prisma.Decimal | number | string | null;
  impressions: bigint | number | null; clicks: bigint | number | null; link_clicks: bigint | number | null;
  conversations_started: bigint | number | null; leads: bigint | number | null; meta_purchases: bigint | number | null;
  reach: bigint | number | null; frequency: Prisma.Decimal | number | string | null;
  conversations_in_bodhinox: bigint | number; purchases: bigint | number; thumbnail_url: string | null;
}

const orNull = (value: Prisma.Decimal | bigint | number | string | null) => (value == null ? null : Number(value));

/**
 * Stored insights for the range with Bodhinox's own counts. Ad rows join
 * referrals by ad id; campaign and ad set rows by the campaign or ad set of
 * each ad (from the stored ad rows). Referrals and purchases are counted on the
 * workspace timezone's days, the closest stand-in for the ad account's
 * reporting days. An object with chats or purchases but no stored insight row
 * in the range is still listed, with Meta's figures null (unknown). App-role
 * read; no Meta call.
 */
export async function listAdsWithInsights(actor: MetaAdsActor, query: AdsQuery, now: number = Date.now()): Promise<AdsWithInsights> {
  const { accountId } = actor;
  const reachPreset = reachPresetFor(query.from, query.to, now);
  const adAccountId = query.adAccountId ?? null;
  return withTenant({ accountId, userId: actor.userId, role: actor.role }, async (tx) => {
    const from = query.from;
    const to = query.to;
    const tz = await workspaceTimezone(tx, accountId);
    const start = Prisma.sql`(${from}::date::timestamp AT TIME ZONE ${tz})`;
    const end = Prisma.sql`((${to}::date + 1)::timestamp AT TIME ZONE ${tz})`;
    const accountFilter = (alias: string) => adAccountId
      ? Prisma.sql`AND ${Prisma.raw(alias)}.ad_account_id = ${adAccountId}` : Prisma.empty;
    // Bodhinox's counts are keyed by ad id; campaigns and ad sets map their ads through the stored ad rows.
    const key = query.level === 'ad' ? Prisma.sql`r.source_id` : Prisma.sql`m.parent_id`;
    const adMap = query.level === 'ad' ? Prisma.empty : Prisma.sql`
      JOIN (SELECT DISTINCT object_id, ${Prisma.raw(query.level === 'adset' ? 'adset_id' : 'campaign_id')} AS parent_id
        FROM meta_ad_insights x WHERE x.account_id=${accountId}::uuid AND x.level='ad'
          AND ${Prisma.raw(query.level === 'adset' ? 'adset_id' : 'campaign_id')} IS NOT NULL ${accountFilter('x')}) m
        ON m.object_id = r.source_id`;
    const adOnly = query.level === 'ad' && adAccountId
      ? Prisma.sql`AND r.source_id IN (SELECT object_id FROM meta_ad_objects WHERE account_id=${accountId}::uuid
          AND level='ad' AND ad_account_id=${adAccountId})`
      : Prisma.empty;
    const rows = await tx.$queryRaw<SummaryRow[]>`
      WITH i AS (
        SELECT object_id AS id, max(ad_account_id) AS ad_account_id, max(campaign_id) AS campaign_id, max(adset_id) AS adset_id,
          (array_agg(name ORDER BY day DESC))[1] AS name, (array_agg(status ORDER BY day DESC))[1] AS status,
          max(objective) AS objective, max(currency) AS currency, sum(spend) AS spend, sum(impressions) AS impressions,
          sum(clicks) AS clicks, sum(link_clicks) AS link_clicks, sum(conversations_started) AS conversations_started,
          sum(leads) AS leads, sum(purchases) AS meta_purchases
        FROM meta_ad_insights i
        WHERE account_id=${accountId}::uuid AND level=${query.level} AND day BETWEEN ${from}::date AND ${to}::date ${accountFilter('i')}
        GROUP BY object_id
      ), refs AS (
        SELECT ${key} AS id, count(DISTINCT coalesce(r.conversation_id::text, r.id::text)) AS n
        FROM ad_referrals r ${adMap}
        WHERE r.account_id=${accountId}::uuid AND r.source_type='ad' AND r.source_id IS NOT NULL
          AND r.created_at >= ${start} AND r.created_at < ${end} ${adOnly}
        GROUP BY 1
      ), buys AS (
        SELECT ${key} AS id, count(*) AS n
        FROM capi_events e JOIN ad_referrals r ON r.account_id = e.account_id AND r.id = e.ad_referral_id ${adMap}
        WHERE e.account_id=${accountId}::uuid AND e.event_name='Purchase' AND e.status IN ('queued','sent','unknown')
          AND r.source_id IS NOT NULL AND e.event_time >= ${start} AND e.event_time < ${end} ${adOnly}
        GROUP BY 1
      ), ids AS (
        SELECT id FROM i UNION SELECT id FROM refs UNION SELECT id FROM buys
      )
      SELECT ids.id, coalesce(i.ad_account_id, latest.ad_account_id) AS ad_account_id,
        coalesce(i.campaign_id, latest.campaign_id) AS campaign_id, coalesce(i.adset_id, latest.adset_id) AS adset_id,
        coalesce(i.name, latest.name, o.name) AS name, coalesce(i.status, latest.status, o.status) AS status,
        coalesce(i.objective, latest.objective) AS objective, coalesce(i.currency, latest.currency) AS currency,
        i.spend, i.impressions, i.clicks, i.link_clicks, i.conversations_started, i.leads, i.meta_purchases,
        rc.reach, rc.frequency, coalesce(refs.n, 0) AS conversations_in_bodhinox, coalesce(buys.n, 0) AS purchases,
        coalesce(o.image_url, o.thumbnail_url) AS thumbnail_url
      FROM ids LEFT JOIN i ON i.id = ids.id LEFT JOIN refs ON refs.id = ids.id LEFT JOIN buys ON buys.id = ids.id
      LEFT JOIN LATERAL (
        SELECT x.ad_account_id, x.campaign_id, x.adset_id, x.name, x.status, x.objective, x.currency FROM meta_ad_insights x
        WHERE x.account_id=${accountId}::uuid AND x.level=${query.level} AND x.object_id = ids.id
        ORDER BY x.day DESC LIMIT 1
      ) latest ON i.id IS NULL
      LEFT JOIN meta_ad_objects o ON o.account_id=${accountId}::uuid AND o.object_id = ids.id
      LEFT JOIN meta_ad_reach rc ON rc.account_id=${accountId}::uuid AND rc.level=${query.level} AND rc.object_id = ids.id
        AND rc.preset=${reachPreset ?? 'last_7d'} AND ${reachPreset !== null}
      WHERE ids.id IS NOT NULL
        AND (${adAccountId}::text IS NULL OR coalesce(i.ad_account_id, latest.ad_account_id, o.ad_account_id) = ${adAccountId})
      ORDER BY i.spend DESC NULLS LAST, coalesce(refs.n, 0) DESC, ids.id
      LIMIT ${MAX_ROWS}`;
    const synced = await tx.$queryRaw<{ insights_synced_at: Date | null }[]>`SELECT insights_synced_at FROM meta_ad_connections
      WHERE account_id=${accountId}::uuid AND status<>'disconnected' LIMIT 1`;
    return {
      rows: rows.map((r) => ({
        id: r.id,
        adAccountId: r.ad_account_id,
        campaignId: r.campaign_id,
        adsetId: r.adset_id,
        name: r.name,
        status: r.status,
        objective: r.objective,
        currency: r.currency,
        spend: orNull(r.spend),
        impressions: orNull(r.impressions),
        clicks: orNull(r.clicks),
        linkClicks: orNull(r.link_clicks),
        conversationsStarted: orNull(r.conversations_started),
        leads: orNull(r.leads),
        metaPurchases: orNull(r.meta_purchases),
        reach: orNull(r.reach),
        frequency: orNull(r.frequency),
        conversationsInBodhinox: Number(r.conversations_in_bodhinox),
        purchases: Number(r.purchases),
        thumbnailUrl: r.thumbnail_url,
      })),
      insightsSyncedAt: synced[0]?.insights_synced_at?.toISOString() ?? null,
      reachPreset,
    };
  });
}

/** Conversations started from ads in the last `days` days, from stored referrals only (always on). */
export async function countAdStartedConversations(actor: MetaAdsActor, days = 30): Promise<number> {
  const rows = await withTenant({ accountId: actor.accountId, userId: actor.userId, role: actor.role }, (tx) =>
    tx.$queryRaw<{ n: bigint | number }[]>`
      SELECT count(DISTINCT coalesce(conversation_id::text, id::text)) AS n FROM ad_referrals
      WHERE account_id=${actor.accountId}::uuid AND source_type='ad' AND created_at >= now() - make_interval(days => ${days}::int)`);
  return Number(rows[0]?.n ?? 0);
}

export const MANUAL_SYNC_BUCKET_MS = 10 * 60_000;

/**
 * Queues an insights sync for the active connection, at most one per
 * 10-minute bucket (dedupe key). Returns false when there is no active
 * connection. App-role insert (tenant_jobs policy).
 */
export async function queueInsightsSync(actor: MetaAdsActor, now: number = Date.now()): Promise<boolean> {
  return withTenant({ accountId: actor.accountId, userId: actor.userId, role: actor.role }, async (tx) => {
    const live = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM meta_ad_connections
      WHERE account_id=${actor.accountId}::uuid AND status='active' LIMIT 1`;
    if (!live[0]) return false;
    await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES('meta.insights_sync',${actor.accountId}::uuid,'{}'::jsonb,
        ${`meta-insights-manual:${actor.accountId}:${Math.floor(now / MANUAL_SYNC_BUCKET_MS)}`},3)
      ON CONFLICT(dedupe_key) DO NOTHING`;
    return true;
  });
}
