import { beforeEach, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ from: vi.fn(), select: vi.fn(), order: vi.fn() }))
vi.mock('@/lib/data/client', () => ({ createClient: () => ({ from: h.from }) }))
import { loadFlowTags } from './load-tags'
beforeEach(() => { h.from.mockReturnValue({ select: h.select }); h.select.mockReturnValue({ order: h.order }) })
it('loads tags through the same scoped data client as the rest of the app', async () => {
  const tags = [{ id: 'tag-1', name: 'Interested', color: '#aa6622' }]
  h.order.mockResolvedValue({ data: tags, error: null })
  expect(await loadFlowTags()).toEqual(tags)
  expect(h.from).toHaveBeenCalledWith('tags')
  expect(h.select).toHaveBeenCalledWith('id,name,color')
  expect(h.order).toHaveBeenCalledWith('name')
})
it('keeps the manual tag entry available if loading fails', async () => {
  h.order.mockResolvedValue({ data: null, error: { message: 'Unavailable' } })
  expect(await loadFlowTags()).toEqual([])
  h.order.mockRejectedValue(new Error('Network unavailable'))
  expect(await loadFlowTags()).toEqual([])
})
