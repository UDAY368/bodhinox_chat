import { describe, expect, it } from 'vitest'
import { isCrawled, nextAccess, shouldPoll, sourceReason, statusVariant } from './source-view'

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

describe('nextAccess', () => {
  const open = { min_role: 'agent' as const, customer_facing: true }
  it('turns customer use off when a source becomes admin-only', () => {
    expect(nextAccess(open, { min_role: 'admin' })).toEqual({ min_role: 'admin', customer_facing: false })
  })
  it('keeps customer use when a source goes back to agents', () => {
    expect(nextAccess({ min_role: 'admin', customer_facing: false }, { min_role: 'agent' })).toEqual({ min_role: 'agent', customer_facing: false })
  })
  it('refuses customer use for an admin-only source', () => {
    expect(nextAccess({ min_role: 'admin', customer_facing: false }, { customer_facing: true })).toBeNull()
  })
})
