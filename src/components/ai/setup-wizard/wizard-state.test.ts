import { describe, expect, it } from 'vitest'
import { AGENT_TONES, agentProfileInputSchema, emptyAgentProfile } from '@/lib/ai/agent-profile'
import { MIN_CONFIDENCE_THRESHOLD, WIZARD_TONES, draftToInput, fullDraftInput, parseKeywords, profileToDraft } from './wizard-state'
import { assessConfidence } from '@/lib/ai/confidence'

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
    expect(handoff_rules.confidence_threshold).toBe(0.5)
    expect(agentProfileInputSchema.safeParse({ handoff_rules }).success).toBe(true)
  })

  it('keeps the confidence slider in the 50-100% range where it changes behaviour (audit 30)', () => {
    // The default 0.35 behaves exactly like 0.5: an answered reply never scores below 0.5.
    expect(profileToDraft(emptyAgentProfile()).confidence_threshold).toBe(MIN_CONFIDENCE_THRESHOLD)
    expect(assessConfidence({ reply: 'Hi!', retrieval: null, threshold: 0.35 }).confident)
      .toBe(assessConfidence({ reply: 'Hi!', retrieval: null, threshold: MIN_CONFIDENCE_THRESHOLD }).confident)
    const draft = profileToDraft(emptyAgentProfile())
    const at = (value: number) => (draftToInput({ ...draft, confidence_threshold: value }, 'handoff') as { handoff_rules: { confidence_threshold: number } }).handoff_rules.confidence_threshold
    expect(at(0.1)).toBe(0.5)
    expect(at(0.8)).toBe(0.8)
    expect(at(4)).toBe(1)
    // Every value above 0.5 changes the outcome for some knowledge-base match strength.
    const weakMatch = { semanticDistances: [0.6] } // similarity 0.4 -> retrieval 0.5 -> score 0.75
    expect(assessConfidence({ reply: 'Yes.', retrieval: weakMatch, threshold: 0.7 }).confident).toBe(true)
    expect(assessConfidence({ reply: 'Yes.', retrieval: weakMatch, threshold: 0.8 }).confident).toBe(false)
  })
})
