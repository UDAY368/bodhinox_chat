import { describe, it, expect } from 'vitest'
import { knowledgeQueryText, latestUserMessage, recentCustomerText } from './query'

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

describe('knowledgeQueryText', () => {
  it('joins a question split over two messages', () => {
    expect(knowledgeQueryText([
      { role: 'user', content: 'Do you deliver to Pune?' },
      { role: 'user', content: 'and how much?' },
    ])).toBe('Do you deliver to Pune?\nand how much?')
  })

  it('keeps the earlier question for a follow-up after an answer', () => {
    expect(knowledgeQueryText([
      { role: 'user', content: 'Do you deliver to Pune?' },
      { role: 'assistant', content: 'Yes.' },
      { role: 'user', content: 'and how much?' },
    ])).toBe('Do you deliver to Pune?\nand how much?')
  })

  it('reads at most the newest three customer turns, skipping blanks', () => {
    expect(knowledgeQueryText([
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: ' ' },
      { role: 'user', content: 'three' },
      { role: 'user', content: 'four' },
    ])).toBe('two\nthree\nfour')
  })

  it('falls back to the latest message when no customer turn has text', () => {
    expect(knowledgeQueryText([{ role: 'assistant', content: 'only assistant' }])).toBe('only assistant')
  })
})
