// Narratives for insight runs.
//
// The model sees only the computed numbers (modelInput): metric names and
// values, row labels ("Agent 1..n", currency codes), the date range, caveat
// codes and the uncertainty. No agent or contact names, no customer content.
// Its text is accepted only when every number in it matches a value in the
// data within rounding (groundedNumbers); otherwise the deterministic template
// narrative is used and 'ungrounded_number' is flagged. The run is always
// useful with AI off: templateNarrative needs no model.

import type { CaveatCode, InsightData, InsightKey, Uncertainty } from './registry';

export const NARRATIVE_MAX_CHARS = 2000;
export const INSIGHT_PROMPT_VERSION = 'insights.v1';

export const INSIGHT_SYSTEM_PROMPT = [
  'You write a short business insight for the staff of a small business, from the metrics in the data block.',
  'Write two to four plain sentences: what stands out, how the parts compare, and one practical thing to look at next.',
  'Use only numbers that appear in the data, written exactly as given (you may round to whole numbers or convert seconds to minutes or hours with one decimal).',
  'Refer to rows only by their label (for example "Agent 1"). Mention the caveats and uncertainty briefly when present.',
  'No headings, lists, markdown, links or code.',
].join('\n');

const fmt = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined ? 'n/a' : v.toLocaleString('en-US', { maximumFractionDigits: digits });
const minutes = (seconds: number | null | undefined): string => (seconds === null || seconds === undefined ? 'n/a' : `${fmt(seconds / 60, 1)} minutes`);

/** A deterministic English summary of the numbers (the UI shows a localised one built from the same data). */
export function templateNarrative(key: InsightKey, data: InsightData): string {
  const m = data.metrics;
  const range = `${data.dataFrom} to ${data.dataTo}`;
  switch (key) {
    case 'conversation_volume':
      return `From ${range}, ${fmt(m.conversations_started)} conversations started: ${fmt(m.started_by_customer)} by customers, ${fmt(m.started_by_business)} by the business, ${fmt(m.campaign_replies)} as campaign replies and ${fmt(m.from_ads)} from ads.`;
    case 'response_times':
      return `From ${range}, the median first response was ${minutes(m.median_first_response_seconds)} (90th percentile ${minutes(m.p90_first_response_seconds)}), with ${fmt(m.unanswered)} conversations still unanswered.`;
    case 'agent_workload':
      return `From ${range}, ${fmt(m.active_agents)} agents handled ${fmt(m.conversations_handled)} conversations and sent ${fmt(m.replies_sent)} replies.`;
    case 'campaign_funnel':
      return `From ${range}, ${fmt(m.campaigns)} campaigns reached ${fmt(m.recipients)} recipients: ${fmt(m.delivery_rate_pct, 1)}% delivered, ${fmt(m.read_rate_pct, 1)}% of those read and ${fmt(m.reply_rate_pct, 1)}% replied.`;
    case 'flow_outcomes':
      return `From ${range}, ${fmt(m.runs_started)} flow runs started and ${fmt(m.completion_rate_pct, 1)}% completed; ${fmt(m.handed_off)} were handed to a person and ${fmt(m.failed)} failed.`;
    case 'template_delivery':
      return `From ${range}, ${fmt(m.sent)} template messages were sent across ${fmt(m.templates_used)} templates: ${fmt(m.delivery_rate_pct, 1)}% delivered and ${fmt(m.failure_rate_pct, 1)}% failed.`;
    case 'ai_performance':
      return `From ${range}, the AI replied in ${fmt(m.ai_conversations)} conversations, handed ${fmt(m.handoffs)} to a person and resolved ${fmt(m.resolved_by_ai)} on its own.`;
    case 'commerce_sales':
      return data.currency
        ? `From ${range}, ${fmt(m.paid_orders)} orders were paid, with net merchandise of ${data.currency} ${fmt(m.net_merchandise, 2)} and ${data.currency} ${fmt(m.net_collected, 2)} collected after refunds.`
        : `From ${range}, no orders were paid.`;
  }
}

/** The numbers-only JSON a model may see. Row names are left out; labels stay. */
export function modelInput(key: InsightKey, data: InsightData, caveats: readonly CaveatCode[], uncertainty: Uncertainty): string {
  return JSON.stringify({
    insight: key,
    from: data.dataFrom,
    to: data.dataTo,
    currency: data.currency ?? undefined,
    metrics: data.metrics,
    rows: data.rows?.map((r) => ({ label: r.label, ...r.values })),
    record_count: data.rowCount,
    caveats,
    uncertainty,
  });
}

/** Every value a narrative may quote: the numbers themselves, and seconds as minutes or hours. */
export function groundingValues(data: InsightData): number[] {
  const out: number[] = [data.rowCount];
  const add = (key: string, value: number | null) => {
    if (value === null || !Number.isFinite(value)) return;
    out.push(value);
    if (key.endsWith('_seconds')) out.push(value / 60, value / 3600);
    if (key.startsWith('p90_')) out.push(90); // "the 90th percentile"
  };
  for (const [k, v] of Object.entries(data.metrics)) add(k, v);
  for (const row of data.rows ?? []) for (const [k, v] of Object.entries(row.values)) add(k, v);
  return out;
}

const matches = (x: number, v: number): boolean => {
  const a = Math.abs(v);
  if (Math.abs(x - v) < 1e-9) return true;
  if (Math.round(v) === x || Math.round(v * 10) / 10 === x || Math.round(v * 100) / 100 === x) return true;
  // "about 12,300" for 12,345: within 1% for values of 1,000 and more.
  return a >= 1000 && Math.abs(x - v) / a <= 0.01;
};

/** Numbers written in `text`, ignoring ISO dates and row labels like "Agent 3". */
export function numbersIn(text: string): number[] {
  const cleaned = text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\bAgent\s+\d+\b/g, ' ');
  return [...cleaned.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, '')));
}

/** True when every number in `text` matches a value in the data. */
export function groundedNumbers(text: string, data: InsightData): boolean {
  const values = groundingValues(data);
  return numbersIn(text).every((x) => values.some((v) => matches(x, v)));
}

/** Replaces "Agent N" labels with the agent's name for staff (labels without a name stay). */
export function restoreNames(text: string, data: InsightData): string {
  const names = new Map((data.rows ?? []).filter((r) => r.name && /^Agent \d+$/.test(r.label)).map((r) => [r.label, r.name as string]));
  if (!names.size) return text;
  return text.replace(/\bAgent \d+\b/g, (label) => names.get(label) ?? label);
}

/** Plain text, single spaces, within the column limit. */
export function cleanNarrative(text: string): string {
  const flat = text.replace(/[*_#`>]+/g, '').replace(/\s+/g, ' ').trim();
  return flat.length <= NARRATIVE_MAX_CHARS ? flat : `${flat.slice(0, NARRATIVE_MAX_CHARS - 1).trimEnd()}…`;
}
