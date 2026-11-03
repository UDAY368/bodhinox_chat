import { describe, expect, it, vi } from 'vitest'
import { saveSuggestedSegment, uniqueSegmentName } from './ai-campaign-assistant'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const filter = { conditions: [{ field: 'opted_out', op: 'is', value: false }] }

describe('uniqueSegmentName', () => {
  it('keeps a free name and suffixes a taken one (case-insensitively)', () => {
    expect(uniqueSegmentName('VIP customers', [])).toBe('VIP customers')
    expect(uniqueSegmentName('VIP customers', ['vip customers'])).toBe('VIP customers (2)')
    expect(uniqueSegmentName('AI segment', ['AI segment', 'AI segment (2)'])).toBe('AI segment (3)')
  })

  it('falls back for a blank name and stays within the 100-character limit', () => {
    expect(uniqueSegmentName('   ', [])).toBe('AI segment')
    const long = 'x'.repeat(100)
    const next = uniqueSegmentName(long, [long])
    expect(next.length).toBeLessThanOrEqual(100)
    expect(next.endsWith(' (2)')).toBe(true)
  })
})

describe('saveSuggestedSegment', () => {
  it('creates the segment under a name that avoids existing segments', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ segments: [{ name: 'AI segment' }] }))
      .mockResolvedValueOnce(json({ segment: { id: 'seg-1' } }, 201))
    await expect(saveSuggestedSegment(fetcher, { name: 'AI segment', filter })).resolves.toEqual({ id: 'seg-1' })
    const [url, init] = fetcher.mock.calls[1]
    expect(url).toBe('/api/segments')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ name: 'AI segment (2)', filter })
  })

  it('still tries the create when listing fails, and reports the server error', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(json({ error: 'A segment with this name already exists' }, 400))
    await expect(saveSuggestedSegment(fetcher, { name: 'VIP', filter })).resolves.toEqual({ error: 'A segment with this name already exists' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
