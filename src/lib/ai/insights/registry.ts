// The fixed registry of business insights. Each key runs one existing
// reporting query (src/lib/analytics) — never free-form SQL, never a query the
// model chooses — and turns its result into numbers only: no message text, no
// contact names or phone numbers. Agent names appear only in agent_workload
// rows, are stored for staff, and are replaced by "Agent 1..n" before anything
// reaches a model (narrative.ts).
//
// INSIGHT_MIN_ROLE mirrors the live analytics endpoint each query backs. The
// effective minimum is max(INSIGHT_MIN_ROLE, agent), because the 'ai.insights'
// permission's ceiling is agent.
//
// Coverage, caveats and uncertainty are computed here, deterministically:
// uncertainty is high when fewer than LOW_SAMPLE rows back the numbers or the
// workspace existed for under half of the range, medium when the agent
// attribution cutoff falls inside the range, and low otherwise.

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { minorToDecimalString } from '@/lib/commerce/money';
import type { TenantTransaction } from '@/lib/db/tenant';
import { commerceStats, type CommerceStats } from '@/lib/analytics/commerce';
import {
  AGENT_ATTRIBUTION_CUTOFF, agentLeaderboard, aiStats, campaignFunnel, conversationStats, flowStats, templateDaily,
  type AgentLeaderboardRow, type AiStats, type CampaignFunnel, type ConversationStats, type FlowStats, type TemplateDailyRow,
} from '@/lib/analytics/queries';
import { dayCount, localDay, type AnalyticsRange } from '@/lib/analytics/range';

export const INSIGHT_KEYS = [
  'conversation_volume', 'response_times', 'agent_workload', 'campaign_funnel',
  'flow_outcomes', 'template_delivery', 'ai_performance', 'commerce_sales',
] as const;
export type InsightKey = (typeof INSIGHT_KEYS)[number];

export const isInsightKey = (value: unknown): value is InsightKey =>
  typeof value === 'string' && (INSIGHT_KEYS as readonly string[]).includes(value);

/** Mirrors the live analytics endpoint each insight is computed from. */
export const INSIGHT_MIN_ROLE: Record<InsightKey, AccountRole> = {
  conversation_volume: 'viewer',
  response_times: 'viewer',
  agent_workload: 'viewer',
  campaign_funnel: 'viewer',
  flow_outcomes: 'viewer',
  template_delivery: 'viewer',
  ai_performance: 'agent',
  commerce_sales: 'agent',
};

/** The effective minimum role: the insight's own, and never below agent ('ai.insights' ceiling). */
export function insightAllowed(role: AccountRole | null | undefined, key: InsightKey): boolean {
  return !!role && hasMinRole(role, 'agent') && hasMinRole(role, INSIGHT_MIN_ROLE[key]);
}

/** Where the same numbers are shown live (the analytics page has one scrolling view). */
export const INSIGHT_SOURCE_LINK: Record<InsightKey, string> = {
  conversation_volume: '/analytics',
  response_times: '/analytics',
  agent_workload: '/analytics',
  campaign_funnel: '/analytics',
  flow_outcomes: '/analytics',
  template_delivery: '/analytics',
  ai_performance: '/analytics',
  commerce_sales: '/analytics',
};

export type CaveatCode = 'agent_attribution_cutoff' | 'csat_not_collected' | 'rate_card_empty' | 'partial_range' | 'low_sample';
export type Uncertainty = 'low' | 'medium' | 'high';

/** One labelled row (an agent, a currency); `name` is shown to staff only, never sent to a model. */
export interface InsightRow {
  label: string;
  name: string | null;
  values: Record<string, number | null>;
}

export interface InsightData {
  metrics: Record<string, number | null>;
  rows?: InsightRow[];
  /** Currency of money metrics (commerce_sales), in major units. */
  currency?: string | null;
  /** How many records back the numbers (conversations, recipients, runs, orders...). */
  rowCount: number;
  /** First and last local day the numbers cover. */
  dataFrom: string;
  dataTo: string;
  /** When the numbers were read (ISO timestamp). */
  asOf: string;
}

export interface InsightCoverage {
  requestedDays: number;
  coveredDays: number;
  /** coveredDays / requestedDays, 0..1 with two decimals. */
  ratio: number;
  /** The range ends today, so its last day is still in progress. */
  inProgress: boolean;
}

export const LOW_SAMPLE = 30;
export const AGENT_ROW_LIMIT = 10;

/** A percentage with one decimal, or null when the denominator is zero. */
export const pctOf = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

// ------------------------------------------------------------------ pure builders (unit-tested)

export function conversationVolumeMetrics(s: ConversationStats): { metrics: Record<string, number | null>; rowCount: number } {
  return {
    metrics: {
      conversations_started: num(s.started.total),
      started_by_customer: num(s.started.inbound),
      started_by_business: num(s.started.business),
      campaign_replies: num(s.started.campaignReply),
      from_ads: num(s.started.ad),
      open_with_bot: num(s.byLifecycle.bot),
      waiting_for_agent: num(s.byLifecycle.requesting),
      assigned: num(s.byLifecycle.assigned),
      resolved: num(s.byLifecycle.resolved),
    },
    rowCount: num(s.started.total),
  };
}

export function responseTimeMetrics(s: ConversationStats): { metrics: Record<string, number | null>; rowCount: number } {
  return {
    metrics: {
      first_responses: num(s.firstResponse.count),
      unanswered: num(s.firstResponse.unanswered),
      median_first_response_seconds: numOrNull(s.firstResponse.medianSeconds),
      p90_first_response_seconds: numOrNull(s.firstResponse.p90Seconds),
      resolved: num(s.resolution.resolved),
      median_resolution_seconds: numOrNull(s.resolution.medianSeconds),
      p90_resolution_seconds: numOrNull(s.resolution.p90Seconds),
    },
    rowCount: num(s.firstResponse.count) + num(s.firstResponse.unanswered),
  };
}

export function agentWorkloadMetrics(board: AgentLeaderboardRow[]):
  { metrics: Record<string, number | null>; rows: InsightRow[]; rowCount: number } {
  const active = board.filter((a) => num(a.conversationsHandled) > 0 || num(a.repliesSent) > 0 || num(a.resolved) > 0);
  const handled = active.reduce((n, a) => n + num(a.conversationsHandled), 0);
  const replies = active.reduce((n, a) => n + num(a.repliesSent), 0);
  const rows = active.slice(0, AGENT_ROW_LIMIT).map((a, i) => ({
    label: `Agent ${i + 1}`,
    name: a.name ?? null,
    values: {
      conversations_handled: num(a.conversationsHandled),
      replies_sent: num(a.repliesSent),
      median_first_response_seconds: numOrNull(a.medianFirstResponseSeconds),
      resolved: num(a.resolved),
    },
  }));
  return {
    metrics: {
      active_agents: active.length,
      conversations_handled: handled,
      replies_sent: replies,
      resolved: active.reduce((n, a) => n + num(a.resolved), 0),
      top_agent_share_pct: rows.length ? pctOf(rows[0].values.conversations_handled ?? 0, handled) : null,
    },
    rows,
    rowCount: handled,
  };
}

export function campaignFunnelMetrics(f: CampaignFunnel): { metrics: Record<string, number | null>; rowCount: number } {
  const t = f.totals;
  return {
    metrics: {
      campaigns: f.broadcasts.length,
      recipients: num(t.recipients),
      sent: num(t.sent),
      delivered: num(t.delivered),
      read: num(t.read),
      replied: num(t.replied),
      clicked: num(t.clicked),
      failed: num(t.failed),
      delivery_rate_pct: pctOf(num(t.delivered), num(t.sent)),
      read_rate_pct: pctOf(num(t.read), num(t.delivered)),
      reply_rate_pct: pctOf(num(t.replied), num(t.delivered)),
    },
    rowCount: num(t.recipients),
  };
}

export function flowOutcomeMetrics(s: FlowStats): { metrics: Record<string, number | null>; rowCount: number } {
  const started = num(s.started);
  return {
    metrics: {
      runs_started: started,
      completed: num(s.completed),
      handed_off: num(s.handedOff),
      timed_out: num(s.timedOut),
      failed: num(s.failed),
      cancelled: num(s.cancelled),
      still_active: num(s.active),
      completion_rate_pct: pctOf(num(s.completed), started),
    },
    rowCount: started,
  };
}

export function templateDeliveryMetrics(rows: TemplateDailyRow[]): { metrics: Record<string, number | null>; rowCount: number } {
  const sum = (k: keyof Omit<TemplateDailyRow, 'day' | 'templateName'>) => rows.reduce((n, r) => n + num(r[k]), 0);
  const sent = sum('sent');
  const delivered = sum('delivered');
  return {
    metrics: {
      templates_used: new Set(rows.map((r) => r.templateName)).size,
      sent,
      delivered,
      read: sum('read'),
      replied: sum('replied'),
      failed: sum('failed'),
      delivery_rate_pct: pctOf(delivered, sent),
      read_rate_pct: pctOf(sum('read'), delivered),
      failure_rate_pct: pctOf(sum('failed'), sent),
    },
    rowCount: sent,
  };
}

export function aiPerformanceMetrics(s: AiStats): { metrics: Record<string, number | null>; rowCount: number } {
  return {
    metrics: {
      ai_replies: num(s.aiReplies),
      ai_conversations: num(s.aiConversations),
      handoffs: num(s.handoffs),
      unanswered_questions: num(s.unansweredRecorded),
      resolved_by_ai: num(s.resolvedByAi),
      resolution_rate_pct: s.resolutionRate === null || s.resolutionRate === undefined ? null : Math.round(num(s.resolutionRate) * 1000) / 10,
    },
    rowCount: num(s.aiConversations),
  };
}

const major = (minor: number, currency: string): number => Number(minorToDecimalString(minor, currency));

/** The currency with the most paid orders is the headline; every currency is a row. */
export function commerceSalesMetrics(s: CommerceStats):
  { metrics: Record<string, number | null>; rows: InsightRow[]; currency: string | null; rowCount: number } {
  const currencies = [...s.currencies].sort((a, b) => num(b.paidOrders) - num(a.paidOrders) || a.currency.localeCompare(b.currency));
  const values = (c: CommerceStats['currencies'][number]): Record<string, number | null> => ({
    paid_orders: num(c.paidOrders),
    net_merchandise: major(num(c.netMerchandiseMinor), c.currency),
    average_order_value: c.averageOrderValueMinor === null ? null : major(num(c.averageOrderValueMinor), c.currency),
    collected: major(num(c.collectedMinor), c.currency),
    refunds: major(num(c.refundsMinor), c.currency),
    net_collected: major(num(c.netCollectedMinor), c.currency),
  });
  const head = currencies[0];
  return {
    metrics: head ? { ...values(head), currencies: currencies.length }
      : { paid_orders: 0, net_merchandise: null, average_order_value: null, collected: null, refunds: null, net_collected: null, currencies: 0 },
    rows: currencies.slice(0, 5).map((c) => ({ label: c.currency, name: null, values: values(c) })),
    currency: head?.currency ?? null,
    rowCount: currencies.reduce((n, c) => n + num(c.paidOrders), 0),
  };
}

// ------------------------------------------------------------------ coverage, caveats, uncertainty

/**
 * How much of the requested range the workspace existed for. `accountCreatedDay`
 * is the workspace's first local day; `today` the local day now.
 */
export function insightCoverage(range: Pick<AnalyticsRange, 'startDay' | 'endDay'>, accountCreatedDay: string, today: string): InsightCoverage {
  const requestedDays = dayCount(range.startDay, range.endDay);
  const start = accountCreatedDay > range.startDay ? accountCreatedDay : range.startDay;
  const coveredDays = start > range.endDay ? 0 : dayCount(start, range.endDay);
  return {
    requestedDays,
    coveredDays,
    ratio: requestedDays > 0 ? Math.round((coveredDays / requestedDays) * 100) / 100 : 0,
    inProgress: range.endDay >= today,
  };
}

export function insightCaveats(key: InsightKey, range: Pick<AnalyticsRange, 'from'>, rowCount: number, coverage: InsightCoverage): CaveatCode[] {
  const caveats: CaveatCode[] = [];
  if (key === 'agent_workload') {
    if (range.from < new Date(AGENT_ATTRIBUTION_CUTOFF)) caveats.push('agent_attribution_cutoff');
    caveats.push('csat_not_collected');
  }
  if (coverage.inProgress || coverage.ratio < 1) caveats.push('partial_range');
  if (rowCount < LOW_SAMPLE) caveats.push('low_sample');
  return caveats;
}

export function insightUncertainty(rowCount: number, coverage: InsightCoverage, caveats: readonly CaveatCode[]): Uncertainty {
  if (rowCount < LOW_SAMPLE || coverage.ratio < 0.5) return 'high';
  if (caveats.includes('agent_attribution_cutoff')) return 'medium';
  return 'low';
}

// ------------------------------------------------------------------ queries

type Computed = { metrics: Record<string, number | null>; rows?: InsightRow[]; currency?: string | null; rowCount: number };

/** Runs the one fixed query for `key`. Inside the caller's tenant transaction (statement timeout already set). */
export async function computeInsight(tx: TenantTransaction, accountId: string, key: InsightKey, range: AnalyticsRange): Promise<Computed> {
  switch (key) {
    case 'conversation_volume': return conversationVolumeMetrics(await conversationStats(tx, accountId, range));
    case 'response_times': return responseTimeMetrics(await conversationStats(tx, accountId, range));
    case 'agent_workload': return agentWorkloadMetrics(await agentLeaderboard(tx, accountId, range));
    case 'campaign_funnel': return campaignFunnelMetrics(await campaignFunnel(tx, accountId, { range }));
    case 'flow_outcomes': return flowOutcomeMetrics(await flowStats(tx, accountId, range));
    case 'template_delivery': return templateDeliveryMetrics(await templateDaily(tx, accountId, range));
    case 'ai_performance': return aiPerformanceMetrics(await aiStats(tx, accountId, range));
    case 'commerce_sales': return commerceSalesMetrics(await commerceStats(tx, accountId, range));
  }
}

/** The workspace's first local day (for coverage). */
export async function accountCreatedDay(tx: TenantTransaction, accountId: string, timezone: string): Promise<string> {
  const rows = await tx.$queryRaw<{ created_at: Date }[]>`SELECT created_at FROM accounts WHERE id=${accountId}::uuid`;
  return rows[0] ? localDay(rows[0].created_at, timezone) : '1970-01-01';
}
