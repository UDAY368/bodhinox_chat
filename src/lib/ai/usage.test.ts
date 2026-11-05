import { describe, it, expect } from 'vitest'
import { estimateUsage, promptCharsOf, usageLog } from './usage'

describe('usageLog', () => {
  it('maps the provider usage to the log row', () => {
    expect(usageLog({
      conversationId: 'conv-1', mode: 'auto_reply', provider: 'anthropic', model: 'claude-x',
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 }, estimate: { promptChars: 0, outputChars: 0 },
    })).toEqual({ conversationId: 'conv-1', mode: 'auto_reply', provider: 'anthropic', model: 'claude-x', promptTokens: 30, completionTokens: 6, totalTokens: 36 })
  })

  it('meters from the estimate (characters / 4) when the provider reported no usage', () => {
    expect(estimateUsage({ promptChars: 400, outputChars: 41 })).toEqual({ promptTokens: 100, completionTokens: 11, totalTokens: 111 })
    expect(usageLog({
      conversationId: null, mode: 'draft', provider: 'openai', model: 'gpt-x', usage: null, estimate: { promptChars: 800, outputChars: 120 },
    })).toMatchObject({ mode: 'draft', promptTokens: 200, completionTokens: 30, totalTokens: 230 })
  })

  it('counts the system prompt and every message', () => {
    expect(promptCharsOf('abcd', [{ content: 'ef' }, { content: 'g' }])).toBe(7)
  })
})
