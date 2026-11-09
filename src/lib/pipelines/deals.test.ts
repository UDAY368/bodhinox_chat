import { describe, expect, it } from 'vitest'
import type { DataClient } from '@/lib/data/types'
import { loadPipelineDeals } from './deals'

/** A data client over `total` deals that serves at most 1,000 rows per request, like the data API. */
function fakeDb(total: number) {
  const calls: { pipeline?: unknown; orders: string[]; from: number; to: number }[] = []
  const db = {
    from(table: string) {
      expect(table).toBe('deals')
      const call: (typeof calls)[number] = { orders: [], from: 0, to: 0 }
      const builder = {
        select: () => builder,
        eq: (_field: string, value: unknown) => { call.pipeline = value; return builder },
        order: (field: string) => { call.orders.push(field); return builder },
        range: async (from: number, to: number) => {
          Object.assign(call, { from, to })
          calls.push(call)
          const end = Math.min(to + 1, total, from + 1000)
          return { data: Array.from({ length: Math.max(0, end - from) }, (_, i) => ({ id: `d${from + i}` })), error: null }
        },
      }
      return builder
    },
  } as unknown as DataClient
  return { db, calls }
}

describe('loadPipelineDeals', () => {
  it('reads every deal in the pipeline past the 1,000-row page', async () => {
    const { db, calls } = fakeDb(2345)
    const deals = await loadPipelineDeals(db, 'pipe-1')
    expect(deals).toHaveLength(2345)
    expect(new Set(deals.map((d) => d.id)).size).toBe(2345)
    expect(calls.map((c) => [c.from, c.to])).toEqual([[0, 999], [1000, 1999], [2000, 2999], [2345, 3344]])
    expect(calls.every((c) => c.pipeline === 'pipe-1')).toBe(true)
    expect(calls[0].orders).toEqual(['created_at', 'id'])
  })

  it('surfaces a failed page instead of showing a partial board', async () => {
    const db = {
      from: () => {
        const builder = { select: () => builder, eq: () => builder, order: () => builder, range: async () => ({ data: null, error: { message: 'boom' } }) }
        return builder
      },
    } as unknown as DataClient
    await expect(loadPipelineDeals(db, 'pipe-1')).rejects.toThrow('boom')
  })
})
