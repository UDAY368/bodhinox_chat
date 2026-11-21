// Shared result shapes the dashboard components consume. Centralised
// here so each component stays thin and the page-level loader wires
// them up without type gymnastics.

export interface MetricDelta {
  current: number
  previous: number
}

export interface MetricsBundle {
  activeConversations: MetricDelta
  newContactsToday: MetricDelta
  openDealsValue: number
  openDealsCount: number
  messagesSentToday: MetricDelta
}

export interface ConversationsSeriesPoint {
  day: string // YYYY-MM-DD local
  incoming: number
  outgoing: number
}

export interface PipelineStageSlice {
  id: string
  name: string
  color: string
  dealCount: number
  totalValue: number
}

export interface PipelineDonutData {
  stages: PipelineStageSlice[]
  totalValue: number
}

export interface ResponseTimeBucket {
  /** 0 = Mon … 6 = Sun (Monday-first). */
  dow: number
  /** Median first reply in minutes (first-reply.ts). Null means no samples. */
  medianMinutes: number | null
  samples: number
}

export interface ResponseTimeSummary {
  buckets: ResponseTimeBucket[]
  thisWeekMedian: number | null
  lastWeekMedian: number | null
}

export type ActivityKind =
  | 'message'
  | 'deal'
  | 'broadcast'
  | 'automation'
  | 'contact'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  /** Primary line of text rendered in the feed. Pre-formatted. */
  text: string
  /** ISO timestamp the item happened at, drives relative-time + sort. */
  at: string
  /** Optional deep-link for the whole row (not all items have a target). */
  href?: string
}

/** GET /api/dashboard/charts: SQL aggregates on the workspace timezone's days. */
export interface DashboardCharts {
  timezone: string
  series: ConversationsSeriesPoint[]
  responseTime: ResponseTimeSummary
  /** Open deals only. */
  dealsByStage: { stageId: string; count: number; value: number }[]
}

/** GET /api/dashboard/business: the Home business cards. Money and AI figures are null for viewers. */
export interface BusinessCards {
  timezone: string
  /** Paid orders' revenue in minor units per currency (analytics_daily, today live). */
  revenue: { todayMinor: Record<string, number>; last7DaysMinor: Record<string, number>; paidOrders7Days: number } | null
  /** Booked (confirmed, completed, no-show) appointments, on each location's local day. */
  bookings: { today: number; upcomingToday: number; next7Days: number }
  /** Meta ads spend over the last 7 days per currency, from synced insights; null without access or ads data. */
  adSpend: { last7Days: { currency: string; amount: number }[] } | null
  /** Conversations the AI closed without a person ("AI handled"). */
  aiHandled: { today: number; last7Days: number } | null
}
