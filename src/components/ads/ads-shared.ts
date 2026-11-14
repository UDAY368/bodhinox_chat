// Pure helpers shared by the Ads page's tabs: the date range presets (which
// match Meta's reach ranges, so reach can be shown for them), rates computed
// in the browser (a zero denominator gives "-", never a fake 0), and the
// platform order and colours of the split.

export type RangePreset = 'last_7d' | 'last_30d' | 'last_90d' | 'custom';

export interface AdsRange {
  preset: RangePreset;
  /** Inclusive YYYY-MM-DD days. */
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;
/** The UTC calendar day (Meta's fixed ranges and the stored rows use the ad account's days; UTC is the closest shared clock). */
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Meta's fixed ranges end yesterday: "Last 7 days" is the 7 days before today. */
export function presetRange(preset: Exclude<RangePreset, 'custom'>, now: number = Date.now()): AdsRange {
  const days = preset === 'last_7d' ? 7 : preset === 'last_30d' ? 30 : 90;
  return { preset, from: utcDay(now - days * DAY_MS), to: utcDay(now - DAY_MS) };
}

/** Longest range the server reads (MAX_RANGE_DAYS). */
export const MAX_RANGE_DAYS = 92;

/** A custom range clamped to the server's limit (the start moves, the end stays). */
export function customRange(from: string, to: string): AdsRange {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return presetRange('last_30d');
  const end = Math.max(a, b);
  const start = Math.max(Math.min(a, b), end - (MAX_RANGE_DAYS - 1) * DAY_MS);
  return { preset: 'custom', from: utcDay(start), to: utcDay(end) };
}

/** a / b, or null when b is 0 or either is unknown. */
export function ratio(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null || b === 0) return null;
  return a / b;
}

export const ctr = (clicks: number | null | undefined, impressions: number | null | undefined) => {
  const r = ratio(clicks, impressions);
  return r === null ? null : r * 100;
};
export const cpm = (spend: number | null | undefined, impressions: number | null | undefined) => {
  const r = ratio(spend, impressions);
  return r === null ? null : r * 1000;
};

export function formatPercent(value: number | null): string {
  return value === null ? '-' : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

/** Amount in the ad account currency when known, else a plain number. */
export function formatMoneyValue(value: number | null, currency: string | null): string {
  if (value === null) return '-';
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
    } catch {
      // Unknown currency code: fall through to a plain number.
    }
  }
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

export const formatNumber = (value: number | null | undefined) => (value == null ? '-' : value.toLocaleString());

/** The kind of result an objective is bought for, to pick the "results" column. */
export type ResultKind = 'conversations' | 'leads' | 'link_clicks' | 'purchases';
export function resultKindOf(objective: string | null): ResultKind {
  switch (objective) {
    case 'OUTCOME_LEADS':
    case 'LEAD_GENERATION':
      return 'leads';
    case 'OUTCOME_TRAFFIC':
    case 'LINK_CLICKS':
      return 'link_clicks';
    case 'OUTCOME_SALES':
    case 'CONVERSIONS':
      return 'purchases';
    default:
      return 'conversations';
  }
}

export const PLATFORM_ORDER = ['facebook', 'instagram', 'messenger', 'whatsapp', 'audience_network', 'threads', 'unknown'] as const;
export type PlatformKey = (typeof PLATFORM_ORDER)[number];
/** Brand-neutral, theme-safe colours (Tailwind classes) for the split bar. */
export const PLATFORM_COLOR: Record<PlatformKey, string> = {
  facebook: 'bg-blue-500',
  instagram: 'bg-pink-500',
  messenger: 'bg-violet-500',
  whatsapp: 'bg-emerald-500',
  audience_network: 'bg-amber-500',
  threads: 'bg-zinc-500',
  unknown: 'bg-zinc-300 dark:bg-zinc-600',
};
