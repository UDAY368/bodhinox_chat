import { describe, expect, it } from 'vitest'
import { NO_ANSWER_SENTINEL, assessConfidence, retrievalScore, stripSentinels } from './confidence'

describe('retrievalScore', () => {
  it('is 0 without matches', () => {
    expect(retrievalScore(null)).toBe(0)
    expect(retrievalScore({})).toBe(0)
    expect(retrievalScore({ semanticDistances: [], lexicalRanks: [] })).toBe(0)
  })

  it('maps the best cosine similarity from 0.2 (0) to 0.6 (1)', () => {
    expect(retrievalScore({ semanticDistances: [0.8] })).toBeCloseTo(0)
    expect(retrievalScore({ semanticDistances: [0.6] })).toBeCloseTo(0.5)
    expect(retrievalScore({ semanticDistances: [0.9, 0.3] })).toBe(1)
    expect(retrievalScore({ semanticDistances: [1.5] })).toBe(0)
  })

  it('weights lexical rank below semantic evidence', () => {
    expect(retrievalScore({ lexicalRanks: [1] })).toBeCloseTo(0.4)
    expect(retrievalScore({ lexicalRanks: [3] })).toBeCloseTo(0.6)
    expect(retrievalScore({ lexicalRanks: [1000] })).toBeLessThan(0.8)
    expect(retrievalScore({ semanticDistances: [0.6], lexicalRanks: [3] })).toBeCloseTo(0.6)
  })

  it('ignores non-finite values', () => {
    expect(retrievalScore({ semanticDistances: [Number.NaN], lexicalRanks: [Number.POSITIVE_INFINITY, -1] })).toBe(0)
  })
})

describe('assessConfidence', () => {
  it('is never confident when the model says it has no answer or wants a person', () => {
    expect(assessConfidence({ reply: NO_ANSWER_SENTINEL, retrieval: { semanticDistances: [0] } }))
      .toEqual({ confident: false, score: 0, reason: 'no_answer', text: '' })
    expect(assessConfidence({ reply: 'Let me check [[HANDOFF]]' })).toMatchObject({ confident: false, reason: 'handoff', text: 'Let me check' })
    expect(assessConfidence({ reply: 'Sure', handoff: true })).toMatchObject({ confident: false, reason: 'handoff' })
    expect(assessConfidence({ reply: '   ' })).toMatchObject({ confident: false, reason: 'empty' })
  })

  it('trusts the model at the default threshold and scales with retrieval evidence', () => {
    expect(assessConfidence({ reply: 'Hello! How can I help?' })).toEqual({ confident: true, score: 0.5, reason: 'answered', text: 'Hello! How can I help?' })
    expect(assessConfidence({ reply: 'We open at 9.', retrieval: { semanticDistances: [0.4] } }).score).toBe(1)
  })

  it('demands knowledge-base support above 0.5', () => {
    expect(assessConfidence({ reply: 'We open at 9.', threshold: 0.8 })).toMatchObject({ confident: false, reason: 'low_score', score: 0.5 })
    expect(assessConfidence({ reply: 'We open at 9.', threshold: 0.8, retrieval: { semanticDistances: [0.5] } }))
      .toMatchObject({ confident: true, score: 0.875 })
  })

  it('clamps an out-of-range threshold', () => {
    expect(assessConfidence({ reply: 'ok', threshold: 5 }).confident).toBe(false)
    expect(assessConfidence({ reply: 'ok', threshold: -1 }).confident).toBe(true)
  })
})

describe('stripSentinels', () => {
  it('removes both control phrases', () => {
    expect(stripSentinels(`a ${NO_ANSWER_SENTINEL} b [[HANDOFF]]`)).toEqual({ text: 'a  b', noAnswer: true, handoff: true })
  })
})
