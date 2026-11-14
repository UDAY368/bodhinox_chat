// One campaign's or ad's stored daily insights for its detail drawer
// (Campaigns redesign): the last 14 days of spend, impressions, clicks and
// conversations started, as Meta reported them in the synced rows. Reads
// stored data only, in the member's tenant scope; never calls Meta.
import { withTenant } from '@/lib/db/tenant';
import type { MetaAdsActor } from './connection';

export const DAILY_DAYS = 14;
/** Meta object ids are numeric strings. */
const OBJECT_ID = /^\d{1,32}$/;

export interface AdDailyPoint {
  day: string;
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  conversations: number;
  leads: number;
}

export interface AdDailySeries {
  currency: string | null;
  points: AdDailyPoint[];
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The last `days` calendar days ending today (UTC), oldest first. */
export function dailyWindow(now: number = Date.now(), days = DAILY_DAYS): string[] {
  return Array.from({ length: days }, (_, i) => isoDay(now - (days - 1 - i) * DAY_MS));
}

/** Null for a malformed query (400). */
export type DailyLevel = 'campaign' | 'adset' | 'ad';

export function parseDailyQuery(params: URLSearchParams): { level: DailyLevel; id: string } | null {
  const level = params.get('level');
  const id = params.get('id') ?? '';
  if ((level !== 'campaign' && level !== 'adset' && level !== 'ad') || !OBJECT_ID.test(id)) return null;
  return { level, id };
}

/** Every day of the window, with zeros where no row was stored. */
export async function adDailySeries(actor: MetaAdsActor, level: DailyLevel, objectId: string, now: number = Date.now()): Promise<AdDailySeries> {
  const days = dailyWindow(now);
  const rows = await withTenant({ accountId: actor.accountId, userId: actor.userId, role: actor.role }, (tx) => tx.$queryRaw<{
    day: Date; spend: unknown; impressions: unknown; clicks: unknown; link_clicks: unknown; conversations: unknown; leads: unknown; currency: string | null;
  }[]>`
    SELECT day, spend, impressions, clicks, link_clicks, conversations_started AS conversations, leads, currency
    FROM meta_ad_insights
    WHERE account_id=${actor.accountId}::uuid AND level=${level} AND object_id=${objectId}
      AND day BETWEEN ${days[0]}::date AND ${days[days.length - 1]}::date
    ORDER BY day`);
  const byDay = new Map(rows.map((r) => [isoDay(new Date(r.day).getTime()), r]));
  return {
    currency: rows.find((r) => r.currency)?.currency ?? null,
    points: days.map((day) => {
      const r = byDay.get(day);
      return {
        day,
        spend: Number(r?.spend ?? 0),
        impressions: Number(r?.impressions ?? 0),
        clicks: Number(r?.clicks ?? 0),
        linkClicks: Number(r?.link_clicks ?? 0),
        conversations: Number(r?.conversations ?? 0),
        leads: Number(r?.leads ?? 0),
      };
    }),
  };
}
