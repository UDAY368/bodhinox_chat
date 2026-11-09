// Campaign and ad insights (part a).
//
// handleInsightsSyncJob (meta.insights_sync, worker) upserts a rolling 30-day
// window of daily campaign- and ad-level rows from the Marketing API. It
// finishes without a network call while the feature is off, when there is no
// active connection or when ads_read was not granted. Meta is called outside
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
import { getInsights, isMetaTokenInvalid, listCampaigns, metaErrorCode, type MetaInsightRow } from './graph';

export const INSIGHTS_WINDOW_DAYS = 30;
/** Rows per upsert statement. */
const CHUNK = 500;
const DAY_MS = 86_400_000;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The [since, until] days (UTC) of the rolling window ending at `now`. */
export function insightsWindow(now: number = Date.now()): { since: string; until: string } {
  return { since: isoDay(now - (INSIGHTS_WINDOW_DAYS - 1) * DAY_MS), until: isoDay(now) };
}

const worker = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());

async function upsertInsightsTx(tx: TenantTransaction, accountId: string, connectionId: string, rows: (MetaInsightRow & { status: string | null })[]) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    await tx.$executeRaw`
      INSERT INTO meta_ad_insights(account_id, connection_id, level, object_id, campaign_id, name, status, objective, day,
        spend, currency, impressions, clicks, conversations_started, synced_at)
      SELECT ${accountId}::uuid, ${connectionId}::uuid, r.level, r.object_id, r.campaign_id, r.name, r.status, r.objective, r.day,
        r.spend, r.currency, r.impressions, r.clicks, r.conversations_started, now()
      FROM unnest(${part.map((r) => r.level)}::text[], ${part.map((r) => r.objectId)}::text[],
        ${part.map((r) => r.campaignId)}::text[], ${part.map((r) => r.name)}::text[], ${part.map((r) => r.status)}::text[],
        ${part.map((r) => r.objective)}::text[], ${part.map((r) => r.day)}::date[], ${part.map((r) => r.spend)}::numeric[],
        ${part.map((r) => r.currency)}::text[], ${part.map((r) => r.impressions)}::bigint[], ${part.map((r) => r.clicks)}::bigint[],
        ${part.map((r) => r.conversationsStarted)}::bigint[])
        AS r(level, object_id, campaign_id, name, status, objective, day, spend, currency, impressions, clicks, conversations_started)
      ON CONFLICT (account_id, level, object_id, day) DO UPDATE SET
        connection_id=EXCLUDED.connection_id, campaign_id=EXCLUDED.campaign_id, name=EXCLUDED.name, status=EXCLUDED.status,
        objective=EXCLUDED.objective, spend=EXCLUDED.spend, currency=EXCLUDED.currency, impressions=EXCLUDED.impressions,
        clicks=EXCLUDED.clicks, conversations_started=EXCLUDED.conversations_started, synced_at=now()`;
  }
}

/** meta.insights_sync: upserts the rolling 30-day window of daily insights. */
export async function handleInsightsSyncJob(accountId: string, payload: Record<string, unknown>): Promise<void> {
  void payload;
  if (!metaAdsConfig()) return;
  const connection = await worker(accountId, (tx) => loadActiveConnectionTx(tx, accountId));
  if (!connection?.adAccountId || !connection.userToken) return;
  if (missingScopes(connection.scopes, 'insights').length) return;
  const { adAccountId, userToken } = connection;
  const window = insightsWindow();

  let rows: (MetaInsightRow & { status: string | null })[];
  try {
    const [campaigns, campaignRows, adRows] = await Promise.all([
      listCampaigns(adAccountId, userToken),
      getInsights(adAccountId, userToken, { level: 'campaign', ...window }),
      getInsights(adAccountId, userToken, { level: 'ad', ...window }),
    ]);
    const status = new Map(campaigns.map((c) => [c.id, c.status]));
    rows = [
      ...campaignRows.map((r) => ({ ...r, status: status.get(r.objectId) ?? null })),
      ...adRows.map((r) => ({ ...r, status: null })),
    ];
  } catch (error) {
    const code = metaErrorCode(error);
    console.error('[meta-ads] insights sync failed', code ?? (error instanceof Error ? error.name : 'unknown'));
    const invalid = isMetaTokenInvalid(error);
    await worker(accountId, (tx) => tx.$executeRaw`UPDATE meta_ad_connections SET last_error_code=${code},
        status=CASE WHEN ${invalid} THEN 'token_invalid' ELSE status END, updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${connection.id}::uuid AND status='active'`);
    // An invalid token cannot recover by retrying; the admin reconnects.
    if (invalid) return;
    // Throttles and other failures retry (the job has maxAttempts 3).
    throw error;
  }

  await worker(accountId, async (tx) => {
    // Still the same active connection: a disconnect during the fetch wins.
    const live = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM meta_ad_connections
      WHERE account_id=${accountId}::uuid AND id=${connection.id}::uuid AND status='active' FOR UPDATE`;
    if (!live[0]) return;
    await upsertInsightsTx(tx, accountId, connection.id, rows);
    await tx.$executeRaw`UPDATE meta_ad_connections SET insights_synced_at=now(), last_error_code=NULL, updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${connection.id}::uuid`;
  });
}

export interface AdsQuery {
  level: 'campaign' | 'ad';
  /** Inclusive YYYY-MM-DD days. */
  from: string;
  to: string;
}

export interface AdInsightSummary {
  id: string;
  campaignId: string | null;
  name: string | null;
  status: string | null;
  objective: string | null;
  currency: string | null;
  /** Meta's figures; null when no insight row is stored for the range (unknown, not zero). */
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  conversationsStarted: number | null;
  /** Conversations Bodhinox saw start from this ad (or this campaign's ads). */
  conversationsInBodhinox: number;
  /** Purchase conversion events attributed to clicks on this ad (or campaign). */
  purchases: number;
}

export interface AdsWithInsights {
  rows: AdInsightSummary[];
  insightsSyncedAt: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The longest range the Ads table reads. */
export const MAX_RANGE_DAYS = 92;
const MAX_ROWS = 500;

/** Validates a range: two real days, from <= to, at most MAX_RANGE_DAYS. Null when invalid. */
export function parseAdsQuery(params: URLSearchParams, now: number = Date.now()): AdsQuery | null {
  const level = params.get('level') ?? 'campaign';
  if (level !== 'campaign' && level !== 'ad') return null;
  const fallback = insightsWindow(now);
  const from = params.get('from') || fallback.since;
  const to = params.get('to') || fallback.until;
  if (!DAY.test(from) || !DAY.test(to)) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || isoDay(a) !== from || isoDay(b) !== to) return null;
  if (b < a || (b - a) / DAY_MS + 1 > MAX_RANGE_DAYS) return null;
  return { level, from, to };
}

interface SummaryRow {
  id: string; campaign_id: string | null; name: string | null; status: string | null; objective: string | null;
  currency: string | null; spend: Prisma.Decimal | number | string | null; impressions: bigint | number | null; clicks: bigint | number | null;
  conversations_started: bigint | number | null; conversations_in_bodhinox: bigint | number; purchases: bigint | number;
}

const orNull = (value: Prisma.Decimal | bigint | number | string | null) => (value == null ? null : Number(value));

/**
 * Stored insights for the range with Bodhinox's own counts. Ad-level rows join
 * referrals by ad id; campaign-level rows by the campaign of each ad (from the
 * stored ad-level rows). Referrals and purchases are counted on the workspace
 * timezone's days, the closest stand-in for the ad account's reporting days.
 * An ad (or campaign) with chats or purchases but no stored insight row in the
 * range is still listed, with Meta's figures null (unknown). App-role read; no
 * Meta call.
 */
export async function listAdsWithInsights(actor: MetaAdsActor, query: AdsQuery): Promise<AdsWithInsights> {
  const { accountId } = actor;
  return withTenant({ accountId, userId: actor.userId, role: actor.role }, async (tx) => {
    const from = query.from;
    const to = query.to;
    const tz = await workspaceTimezone(tx, accountId);
    const start = Prisma.sql`(${from}::date::timestamp AT TIME ZONE ${tz})`;
    const end = Prisma.sql`((${to}::date + 1)::timestamp AT TIME ZONE ${tz})`;
    const key = query.level === 'ad' ? Prisma.sql`r.source_id` : Prisma.sql`m.campaign_id`;
    const adMap = query.level === 'ad' ? Prisma.empty : Prisma.sql`
      JOIN (SELECT DISTINCT object_id, campaign_id FROM meta_ad_insights
        WHERE account_id=${accountId}::uuid AND level='ad' AND campaign_id IS NOT NULL) m ON m.object_id = r.source_id`;
    const rows = await tx.$queryRaw<SummaryRow[]>`
      WITH i AS (
        SELECT object_id AS id, max(campaign_id) AS campaign_id, (array_agg(name ORDER BY day DESC))[1] AS name,
          (array_agg(status ORDER BY day DESC))[1] AS status, max(objective) AS objective, max(currency) AS currency,
          sum(spend) AS spend, sum(impressions) AS impressions, sum(clicks) AS clicks,
          sum(conversations_started) AS conversations_started
        FROM meta_ad_insights
        WHERE account_id=${accountId}::uuid AND level=${query.level} AND day BETWEEN ${from}::date AND ${to}::date
        GROUP BY object_id
      ), refs AS (
        SELECT ${key} AS id, count(DISTINCT coalesce(r.conversation_id::text, r.id::text)) AS n
        FROM ad_referrals r ${adMap}
        WHERE r.account_id=${accountId}::uuid AND r.source_type='ad' AND r.source_id IS NOT NULL
          AND r.created_at >= ${start} AND r.created_at < ${end}
        GROUP BY 1
      ), buys AS (
        SELECT ${key} AS id, count(*) AS n
        FROM capi_events e JOIN ad_referrals r ON r.account_id = e.account_id AND r.id = e.ad_referral_id ${adMap}
        WHERE e.account_id=${accountId}::uuid AND e.event_name='Purchase' AND e.status IN ('queued','sent','unknown')
          AND r.source_id IS NOT NULL AND e.event_time >= ${start} AND e.event_time < ${end}
        GROUP BY 1
      ), ids AS (
        SELECT id FROM i UNION SELECT id FROM refs UNION SELECT id FROM buys
      )
      SELECT ids.id, coalesce(i.campaign_id, latest.campaign_id) AS campaign_id, coalesce(i.name, latest.name) AS name,
        coalesce(i.status, latest.status) AS status, coalesce(i.objective, latest.objective) AS objective,
        coalesce(i.currency, latest.currency) AS currency, i.spend, i.impressions, i.clicks, i.conversations_started,
        coalesce(refs.n, 0) AS conversations_in_bodhinox, coalesce(buys.n, 0) AS purchases
      FROM ids LEFT JOIN i ON i.id = ids.id LEFT JOIN refs ON refs.id = ids.id LEFT JOIN buys ON buys.id = ids.id
      LEFT JOIN LATERAL (
        SELECT x.campaign_id, x.name, x.status, x.objective, x.currency FROM meta_ad_insights x
        WHERE x.account_id=${accountId}::uuid AND x.level=${query.level} AND x.object_id = ids.id
        ORDER BY x.day DESC LIMIT 1
      ) latest ON i.id IS NULL
      WHERE ids.id IS NOT NULL
      ORDER BY i.spend DESC NULLS LAST, coalesce(refs.n, 0) DESC, ids.id
      LIMIT ${MAX_ROWS}`;
    const synced = await tx.$queryRaw<{ insights_synced_at: Date | null }[]>`SELECT insights_synced_at FROM meta_ad_connections
      WHERE account_id=${accountId}::uuid AND status<>'disconnected' LIMIT 1`;
    return {
      rows: rows.map((r) => ({
        id: r.id,
        campaignId: r.campaign_id,
        name: r.name,
        status: r.status,
        objective: r.objective,
        currency: r.currency,
        spend: orNull(r.spend),
        impressions: orNull(r.impressions),
        clicks: orNull(r.clicks),
        conversationsStarted: orNull(r.conversations_started),
        conversationsInBodhinox: Number(r.conversations_in_bodhinox),
        purchases: Number(r.purchases),
      })),
      insightsSyncedAt: synced[0]?.insights_synced_at?.toISOString() ?? null,
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
