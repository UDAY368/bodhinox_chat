import { describe, expect, it } from 'vitest'
import {
  formatMetric, knownCaveats, metricKind, reasonKey, shouldPollInsights, templateParams, uncertaintyVariant, type MetricFormatters,
} from './insight-view'

const f: MetricFormatters = {
  duration: (s) => `${s}s`, percent: (v) => `${v}%`, money: (v, c) => `${c} ${v}`, count: (v) => String(v), missing: '–',
}

describe('insight view helpers', () => {
  it('polls only while a run is queued or running', () => {
    expect(shouldPollInsights([{ status: 'done' }, { status: 'running' }])).toBe(true)
    expect(shouldPollInsights([{ status: 'done' }, { status: 'skipped' }, { status: 'failed' }])).toBe(false)
  })

  it('formats each metric by its kind', () => {
    expect(metricKind('median_first_response_seconds')).toBe('duration')
    expect(formatMetric('delivery_rate_pct', 90.5, null, f)).toBe('90.5%')
    expect(formatMetric('net_merchandise', 12.5, 'INR', f)).toBe('INR 12.5')
    expect(formatMetric('net_merchandise', 12.5, null, f)).toBe('12.5')
    expect(formatMetric('sent', null, null, f)).toBe('–')
    expect(formatMetric('median_first_response_seconds', 60, null, f)).toBe('60s')
  })

  it('builds template parameters from every metric and the range', () => {
    expect(templateParams({ metrics: { sent: 3, delivery_rate_pct: null }, rowCount: 3, dataFrom: 'a', dataTo: 'b', asOf: 'c', currency: null }, f))
      .toEqual({ from: 'a', to: 'b', currency: '', sent: '3', delivery_rate_pct: '–' })
  })

  it('keeps only known caveat and reason codes', () => {
    expect(knownCaveats(['low_sample', '<b>x</b>'])).toEqual(['low_sample'])
    expect(reasonKey(null)).toBeNull()
    expect(reasonKey('quota')).toBe('quota')
    expect(reasonKey('something_else')).toBe('unknown')
  })

  it('marks high uncertainty most strongly', () => {
    expect(uncertaintyVariant('high')).toBe('destructive')
    expect(uncertaintyVariant('low')).toBe('outline')
  })
})
