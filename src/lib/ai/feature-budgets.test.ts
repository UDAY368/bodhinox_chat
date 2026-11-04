import { describe, expect, it } from 'vitest'
import { FEATURE_BUDGETS, maxTokensFor, promptTokenBound } from './feature-budgets'

describe('maxTokensFor (pre-call worst case)', () => {
  it('counts ASCII at characters / 4 and every other character at one token', () => {
    expect(promptTokenBound('abcd'.repeat(10))).toBe(10)
    expect(promptTokenBound('नमस्ते')).toBe(6)
    expect(promptTokenBound('안녕하세요 hi')).toBe(5 + 1)
  })

  it('adds the feature output cap; a bare character count is one token per character', () => {
    expect(maxTokensFor('summary', 'x'.repeat(400))).toBe(100 + FEATURE_BUDGETS.summary.maxOutputTokens)
    expect(maxTokensFor('summary', 'த'.repeat(400))).toBe(400 + FEATURE_BUDGETS.summary.maxOutputTokens)
    expect(maxTokensFor('suggest', 1000)).toBe(1000 + FEATURE_BUDGETS.suggest.maxOutputTokens)
  })
})
