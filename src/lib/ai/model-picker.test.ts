import { describe, expect, it } from 'vitest'
import { AI_PROVIDER_DEFAULT_MODEL, AI_PROVIDER_MODELS, OTHER_MODEL, modelChoice } from './defaults'

describe('AI model picker', () => {
  it('lists the recommended default first for every provider with a list', () => {
    for (const provider of ['openai', 'anthropic', 'gemini'] as const)
      expect(AI_PROVIDER_MODELS[provider][0]).toBe(AI_PROVIDER_DEFAULT_MODEL[provider])
  })

  it('selects a listed model', () => {
    expect(modelChoice('anthropic', 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(modelChoice('openai', ' gpt-5.4 ')).toBe('gpt-5.4')
  })

  it('keeps a saved free-text model as "Other…" so it is not lost', () => {
    expect(modelChoice('openai', 'ft:gpt-4o-mini:acme:2026')).toBe(OTHER_MODEL)
    // The previous Anthropic default stays a listed choice for workspaces that saved it.
    expect(modelChoice('anthropic', 'claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
    // A model listed for another provider is free text here.
    expect(modelChoice('gemini', 'gpt-5.4-mini')).toBe(OTHER_MODEL)
  })

  it('has no list for an OpenAI-compatible endpoint (always free text)', () => {
    expect(AI_PROVIDER_MODELS.openai_compatible).toEqual([])
    expect(modelChoice('openai_compatible', 'llama-3.3-70b')).toBe(OTHER_MODEL)
  })
})
