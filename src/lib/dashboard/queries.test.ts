import { describe, expect, it, vi } from 'vitest'
import type { DataClient } from '@/lib/data/types'
import { fetchDashboardCharts, loadPipelineDonut } from './queries'
import type { DashboardCharts } from './types'

vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn() }))

const charts: DashboardCharts = {
  timezone: 'Asia/Kolkata',
  series: [{ day: '2026-11-10', incoming: 1500, outgoing: 1400 }],
  responseTime: { buckets: [], thisWeekAvg: null, lastWeekAvg: null },
  dealsByStage: [{ stageId: 's1', count: 1200, value: 2400 }],
}

describe('dashboard queries', () => {
  it('reads the SQL-aggregated charts for the requested range', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(charts), { status: 200 }))
    await expect(fetchDashboardCharts(90, fetcher)).resolves.toEqual(charts)
    expect(fetcher).toHaveBeenCalledWith('/api/dashboard/charts?days=90', { cache: 'no-store' })
  })

  it('fails loudly instead of showing empty charts when the endpoint refuses', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 429 }))
    await expect(fetchDashboardCharts(30, fetcher)).rejects.toThrow('429')
  })

  it('builds the donut from SQL stage totals, not a capped deal list', async () => {
    const stages = [
      { id: 's1', name: 'New', color: '', pipeline_id: 'p', position: 0 },
      { id: 's2', name: 'Empty', color: '#fff', pipeline_id: 'p', position: 1 },
    ]
    const db = {
      from: () => ({ select: () => ({ order: async () => ({ data: stages, error: null }) }) }),
    } as unknown as DataClient
    const donut = await loadPipelineDonut(db, Promise.resolve(charts))
    expect(donut).toEqual({
      stages: [{ id: 's1', name: 'New', color: '#64748b', dealCount: 1200, totalValue: 2400 }],
      totalValue: 2400,
    })
  })
})
