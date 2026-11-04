import { describe, it, expect } from 'vitest'
import { latestUserMessage, recentCustomerText } from './query'

describe('latestUserMessage', () => {
  it('returns the most recent user turn', () => {
    expect(
      latestUserMessage([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'latest' },
      ]),
    ).toBe('latest')
  })

  it('falls back to the last message when none are user', () => {
    expect(
      latestUserMessage([{ role: 'assistant', content: 'only assistant' }]),
    ).toBe('only assistant')
  })

  it('returns empty string for no messages', () => {
    expect(latestUserMessage([])).toBe('')
  })
})

describe('recentCustomerText', () => {
  it('joins every customer turn since the last reply, newest three at most', () => {
    expect(recentCustomerText([
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'chest pain' },
      { role: 'user', content: 'hello??' },
    ])).toBe('chest pain\nhello??')
    expect(recentCustomerText(['a', 'b', 'c', 'd'].map((content) => ({ role: 'user' as const, content })))).toBe('b\nc\nd')
  })

  it('falls back to the latest customer turn when a reply came last', () => {
    expect(recentCustomerText([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }])).toBe('q')
  })
})
