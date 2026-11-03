import { describe, expect, it } from 'vitest'
import { isCrawled, shouldPoll, sourceReason, statusVariant } from './source-view'

describe('source view helpers', () => {
  it('maps stored reason codes and hides unknown text', () => {
    expect(sourceReason(null)).toBeNull()
    expect(sourceReason('embeddings_key_missing')).toBe('embeddings_key_missing')
    expect(sourceReason('some raw provider message')).toBe('unknown')
  })

  it('polls only while a source is queued or crawling', () => {
    expect(shouldPoll([{ status: 'ready' }, { status: 'failed' }])).toBe(false)
    expect(shouldPoll([{ status: 'ready' }, { status: 'crawling' }])).toBe(true)
    expect(shouldPoll([{ status: 'queued' }])).toBe(true)
  })

  it('picks badge variants and crawled kinds', () => {
    expect(statusVariant('ready')).toBe('default')
    expect(statusVariant('failed')).toBe('destructive')
    expect(statusVariant('crawling')).toBe('secondary')
    expect(isCrawled('website')).toBe(true)
    expect(isCrawled('file')).toBe(false)
  })
})
