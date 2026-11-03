import { describe, expect, it } from 'vitest'
import { AGENT_TONES, agentProfileInputSchema, emptyAgentProfile } from '@/lib/ai/agent-profile'
import { WIZARD_TONES, draftToInput, fullDraftInput, parseKeywords, profileToDraft } from './wizard-state'

describe('setup wizard state', () => {
  it('keeps the client tone list in sync with the server', () => {
    expect([...WIZARD_TONES]).toEqual([...AGENT_TONES])
  })

  it('parses typed keywords into a clean, deduped list', () => {
    expect(parseKeywords(' Refund, MANAGER\nrefund ,, talk  to human ')).toEqual(['refund', 'manager', 'talk to human'])
    expect(parseKeywords('')).toEqual([])
  })

  it('round-trips an empty profile and produces a body the server schema accepts', () => {
    const draft = profileToDraft(emptyAgentProfile())
    expect(draft.keywords).toBe('')
    const body = { ...fullDraftInput({ ...draft, keywords: 'refund', website_url: 'example.com', tone: 'friendly' }), complete_setup: true }
    const parsed = agentProfileInputSchema.safeParse(body)
    expect(parsed.success).toBe(true)
  })

  it('sends only the fields of the current step', () => {
    const draft = profileToDraft(emptyAgentProfile())
    expect(Object.keys(draftToInput(draft, 'greeting'))).toEqual(['greeting'])
    expect(draftToInput(draft, 'knowledge')).toEqual({})
    expect(draftToInput(draft, 'review')).toEqual({})
  })

  it('clamps handoff numbers into the server limits', () => {
    const draft = { ...profileToDraft(emptyAgentProfile()), max_turns_before_handoff: 999, confidence_threshold: Number.NaN }
    const { handoff_rules } = draftToInput(draft, 'handoff') as { handoff_rules: { max_turns_before_handoff: number; confidence_threshold: number } }
    expect(handoff_rules.max_turns_before_handoff).toBe(50)
    expect(handoff_rules.confidence_threshold).toBe(0.35)
    expect(agentProfileInputSchema.safeParse({ handoff_rules }).success).toBe(true)
  })
})
