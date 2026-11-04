import { describe, expect, it } from 'vitest'
import {
  cleanNarrative, groundedNumbers, modelInput, NARRATIVE_MAX_CHARS, numbersIn, restoreNames, templateNarrative,
} from './narrative'
import {
  agentWorkloadMetrics, aiPerformanceMetrics, campaignFunnelMetrics, commerceSalesMetrics, conversationVolumeMetrics,
  flowOutcomeMetrics, insightAllowed, insightCaveats, insightCoverage, insightUncertainty, INSIGHT_KEYS, isInsightKey,
  responseTimeMetrics, templateDeliveryMetrics, type InsightData,
} from './registry'

const range = { dataFrom: '2026-10-01', dataTo: '2026-10-31', asOf: '2026-11-01T00:00:00.000Z' }
const stats = {
  started: { total: 120, inbound: 80, business: 20, campaignReply: 15, ad: 5 },
  byLifecycle: { bot: 3, requesting: 4, assigned: 10, resolved: 90 },
  firstResponse: { count: 100, unanswered: 20, medianSeconds: 330, p90Seconds: 3600 },
  resolution: { resolved: 90, count: 80, medianSeconds: 7200, p90Seconds: 86400 },
}
const workload = agentWorkloadMetrics([
  { userId: 'u1', name: 'Asha Rao', role: 'agent', conversationsHandled: 40, repliesSent: 120, firstResponseCount: 30, medianFirstResponseSeconds: 300, resolved: 25 },
  { userId: 'u2', name: null, role: 'agent', conversationsHandled: 20, repliesSent: 50, firstResponseCount: 15, medianFirstResponseSeconds: null, resolved: 10 },
  { userId: 'u3', name: 'Idle', role: 'viewer', conversationsHandled: 0, repliesSent: 0, firstResponseCount: 0, medianFirstResponseSeconds: null, resolved: 0 },
])
const data = (d: Omit<InsightData, 'dataFrom' | 'dataTo' | 'asOf'>): InsightData => ({ ...d, ...range })

describe('insight registry', () => {
  it('knows exactly the eight fixed keys', () => {
    expect(INSIGHT_KEYS).toHaveLength(8)
    expect(isInsightKey('conversation_volume')).toBe(true)
    expect(isInsightKey('SELECT 1')).toBe(false)
    expect(isInsightKey(undefined)).toBe(false)
  })

  it('needs agent or above, and agent for the AI and commerce insights', () => {
    expect(insightAllowed('viewer', 'conversation_volume')).toBe(false)
    expect(insightAllowed('agent', 'conversation_volume')).toBe(true)
    expect(insightAllowed('agent', 'commerce_sales')).toBe(true)
    expect(insightAllowed(null, 'commerce_sales')).toBe(false)
  })

  it('turns query results into numbers only', () => {
    expect(conversationVolumeMetrics(stats)).toMatchObject({ rowCount: 120, metrics: { conversations_started: 120, from_ads: 5 } })
    expect(responseTimeMetrics(stats)).toMatchObject({ rowCount: 120, metrics: { median_first_response_seconds: 330 } })
    expect(workload.metrics).toMatchObject({ active_agents: 2, conversations_handled: 60, replies_sent: 170, top_agent_share_pct: 66.7 })
    expect(workload.rows.map((r) => r.label)).toEqual(['Agent 1', 'Agent 2'])
    const funnel = campaignFunnelMetrics({ totals: { recipients: 100, sent: 100, delivered: 90, read: 45, replied: 9, clicked: 3, failed: 10 }, broadcasts: [] })
    expect(funnel.metrics).toMatchObject({ delivery_rate_pct: 90, read_rate_pct: 50, reply_rate_pct: 10 })
    expect(flowOutcomeMetrics({ started: 0, completed: 0, handedOff: 0, timedOut: 0, failed: 0, cancelled: 0, active: 0, dropOff: [] }).metrics.completion_rate_pct).toBeNull()
    expect(templateDeliveryMetrics([
      { day: '2026-10-01', templateName: 'a', sent: 10, delivered: 9, read: 5, replied: 1, clicked: 0, failed: 1 },
      { day: '2026-10-02', templateName: 'b', sent: 10, delivered: 9, read: 4, replied: 0, clicked: 0, failed: 1 },
    ]).metrics).toMatchObject({ templates_used: 2, sent: 20, delivery_rate_pct: 90, failure_rate_pct: 10 })
    expect(aiPerformanceMetrics({ aiReplies: 10, aiConversations: 5, handoffs: 1, unansweredRecorded: 2, resolvedByAi: 2, resolutionRate: 0.4 }).metrics.resolution_rate_pct).toBe(40)
  })

  it('reports commerce in major units, the busiest currency first', () => {
    const blank = { grossMerchandiseMinor: 0, discountsMinor: 0, taxMinor: 0, shippingMinor: 0, merchandiseRefundsMinor: 0, gatewayCollectedMinor: 0, offlineCollectedMinor: 0, externalRefundsMinor: 0 }
    const c = commerceSalesMetrics({
      currencies: [
        { ...blank, currency: 'USD', paidOrders: 1, netMerchandiseMinor: 1000, averageOrderValueMinor: 1000, collectedMinor: 1000, refundsMinor: 0, netCollectedMinor: 1000 },
        { ...blank, currency: 'INR', paidOrders: 3, netMerchandiseMinor: 123450, averageOrderValueMinor: 41150, collectedMinor: 123450, refundsMinor: 450, netCollectedMinor: 123000 },
      ],
      daily: [],
    })
    expect(c.currency).toBe('INR')
    expect(c.metrics).toMatchObject({ paid_orders: 3, net_merchandise: 1234.5, net_collected: 1230, currencies: 2 })
    expect(c.rows.map((r) => r.label)).toEqual(['INR', 'USD'])
    expect(c.rowCount).toBe(4)
  })

  it('computes coverage, caveats and uncertainty deterministically', () => {
    const full = insightCoverage({ startDay: '2026-10-01', endDay: '2026-10-30' }, '2026-01-01', '2026-11-04')
    expect(full).toEqual({ requestedDays: 30, coveredDays: 30, ratio: 1, inProgress: false })
    const young = insightCoverage({ startDay: '2026-10-01', endDay: '2026-10-30' }, '2026-10-21', '2026-11-04')
    expect(young.ratio).toBe(0.33)
    const today = insightCoverage({ startDay: '2026-10-06', endDay: '2026-11-04' }, '2026-01-01', '2026-11-04')
    expect(today.inProgress).toBe(true)

    const after = { from: new Date('2026-11-05T00:00:00Z') }
    expect(insightCaveats('conversation_volume', after, 100, full)).toEqual([])
    expect(insightCaveats('conversation_volume', after, 5, young)).toEqual(['partial_range', 'low_sample'])
    expect(insightCaveats('agent_workload', { from: new Date('2026-10-01T00:00:00Z') }, 100, full))
      .toEqual(['agent_attribution_cutoff', 'csat_not_collected'])

    expect(insightUncertainty(100, full, [])).toBe('low')
    expect(insightUncertainty(29, full, [])).toBe('high')
    expect(insightUncertainty(100, young, [])).toBe('high')
    expect(insightUncertainty(100, full, ['agent_attribution_cutoff'])).toBe('medium')
  })
})

describe('insight narratives', () => {
  const d = data(workload)

  it('sends the model numbers and labels only, never names', () => {
    const input = modelInput('agent_workload', d, ['csat_not_collected'], 'medium')
    expect(input).toContain('"Agent 1"')
    expect(input).not.toContain('Asha')
    expect(JSON.parse(input)).toMatchObject({ insight: 'agent_workload', from: '2026-10-01', to: '2026-10-31', uncertainty: 'medium' })
  })

  it('accepts only numbers that are in the data (rounded, or seconds as minutes)', () => {
    const times = data(responseTimeMetrics(stats))
    expect(groundedNumbers('The median first response was 5.5 minutes; 20 stayed unanswered.', times)).toBe(true)
    expect(groundedNumbers('The 90th percentile was 1 hour.', times)).toBe(true)
    expect(groundedNumbers('Between 2026-10-01 and 2026-10-31 nothing changed.', times)).toBe(true)
    expect(groundedNumbers('About 37 conversations went unanswered.', times)).toBe(false)
    expect(groundedNumbers('Agent 1 handled 40 of 60 conversations (66.7%).', d)).toBe(true)
    expect(groundedNumbers('Agent 1 handled 41 conversations.', d)).toBe(false)
  })

  it('reads numbers with thousands separators and ignores dates and agent labels', () => {
    expect(numbersIn('1,234.5 and 12 on 2026-10-01 by Agent 7')).toEqual([1234.5, 12])
  })

  it('maps agent labels back to names for staff, leaving unnamed labels', () => {
    expect(restoreNames('Agent 1 and Agent 2 and Agent 10.', d)).toBe('Asha Rao and Agent 2 and Agent 10.')
  })

  it('has a template for every key that needs no model', () => {
    expect(templateNarrative('agent_workload', d)).toContain('2 agents handled 60 conversations')
    expect(templateNarrative('commerce_sales', data({ metrics: { paid_orders: 0 }, rowCount: 0, currency: null }))).toContain('no orders')
    for (const key of INSIGHT_KEYS) expect(templateNarrative(key, data({ metrics: {}, rowCount: 0 })).length).toBeGreaterThan(10)
  })

  it('keeps narratives plain text within the column limit', () => {
    expect(cleanNarrative('**Bold**  # heading\n\n`x`')).toBe('Bold heading x')
    expect(cleanNarrative('a'.repeat(5000))).toHaveLength(NARRATIVE_MAX_CHARS)
  })
})
