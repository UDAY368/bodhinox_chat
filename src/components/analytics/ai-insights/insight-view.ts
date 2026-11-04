// Pure helpers for the AI insights panel (kept out of the component so they are unit-tested).

export const INSIGHT_KEYS = [
  'conversation_volume', 'response_times', 'agent_workload', 'campaign_funnel',
  'flow_outcomes', 'template_delivery', 'ai_performance', 'commerce_sales',
] as const;
export type InsightKey = (typeof INSIGHT_KEYS)[number];
export type InsightStatus = 'queued' | 'running' | 'done' | 'skipped' | 'failed';
export type Uncertainty = 'low' | 'medium' | 'high';

export interface InsightRowView {
  label: string;
  name: string | null;
  values: Record<string, number | null>;
}

export interface InsightDataView {
  metrics: Record<string, number | null>;
  rows?: InsightRowView[];
  currency?: string | null;
  rowCount: number;
  dataFrom: string;
  dataTo: string;
  asOf: string;
}

export interface InsightRunView {
  id: string;
  key: InsightKey;
  from: string;
  to: string;
  status: InsightStatus;
  data: InsightDataView | null;
  coverage: { requestedDays: number; coveredDays: number; ratio: number; inProgress: boolean } | null;
  caveats: string[];
  uncertainty: Uncertainty | null;
  narrative: string | null;
  narrativeSource: 'model' | 'template' | null;
  guardFlags: string[];
  sourceLinks: { key: string; href: string }[];
  errorCode: string | null;
  mine: boolean;
  createdAt: string;
  completedAt: string | null;
}

export const KNOWN_CAVEATS = ['agent_attribution_cutoff', 'csat_not_collected', 'rate_card_empty', 'partial_range', 'low_sample'] as const;
/** Reason codes with a translated explanation (AiInsights.reasons.<code>); anything else is generic. */
export const KNOWN_REASONS = [
  'deployment_off', 'not_configured', 'feature_off', 'no_permission', 'quota', 'timeout', 'provider_error',
  'invalid_output', 'guard_blocked', 'ungrounded_number', 'job_failed',
] as const;

export const isPending = (run: Pick<InsightRunView, 'status'>) => run.status === 'queued' || run.status === 'running';
/** Poll while any shown run is queued or running. */
export const shouldPollInsights = (runs: Pick<InsightRunView, 'status'>[]) => runs.some(isPending);

export const knownCaveats = (caveats: readonly string[]) =>
  caveats.filter((c): c is (typeof KNOWN_CAVEATS)[number] => (KNOWN_CAVEATS as readonly string[]).includes(c));

export function reasonKey(code: string | null): (typeof KNOWN_REASONS)[number] | 'unknown' | null {
  if (!code) return null;
  return (KNOWN_REASONS as readonly string[]).includes(code) ? (code as (typeof KNOWN_REASONS)[number]) : 'unknown';
}

export type MetricKind = 'duration' | 'percent' | 'money' | 'count';
const MONEY = new Set(['net_merchandise', 'average_order_value', 'collected', 'refunds', 'net_collected']);

export function metricKind(name: string): MetricKind {
  if (name.endsWith('_seconds')) return 'duration';
  if (name.endsWith('_pct')) return 'percent';
  if (MONEY.has(name)) return 'money';
  return 'count';
}

export interface MetricFormatters {
  duration: (seconds: number) => string;
  percent: (value: number) => string;
  money: (value: number, currency: string) => string;
  count: (value: number) => string;
  missing: string;
}

export function formatMetric(name: string, value: number | null, currency: string | null | undefined, f: MetricFormatters): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return f.missing;
  const kind = metricKind(name);
  if (kind === 'duration') return f.duration(value);
  if (kind === 'percent') return f.percent(value);
  if (kind === 'money') return currency ? f.money(value, currency) : f.count(value);
  return f.count(value);
}

/** Every metric formatted, plus the range and currency: the parameters of the localised template summary. */
export function templateParams(data: InsightDataView, f: MetricFormatters): Record<string, string> {
  const params: Record<string, string> = { from: data.dataFrom, to: data.dataTo, currency: data.currency ?? '' };
  for (const [name, value] of Object.entries(data.metrics)) params[name] = formatMetric(name, value, data.currency, f);
  return params;
}

export function uncertaintyVariant(u: Uncertainty | null): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (u === 'high') return 'destructive';
  if (u === 'medium') return 'secondary';
  return 'outline';
}
