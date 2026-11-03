// Pure state helpers for the AI agent setup wizard (no React, unit tested).
import type { AgentProfile, AgentTone, HandoffRules } from '@/lib/ai/agent-profile'

/** Mirrors AGENT_TONES; kept here so the client bundle never imports the server module. */
export const WIZARD_TONES = ['friendly', 'professional', 'concise', 'enthusiastic', 'formal'] as const satisfies readonly AgentTone[]

export const WIZARD_STEPS = ['business', 'instructions', 'greeting', 'handoff', 'knowledge', 'review'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

/** Suggestions for the business type field; any free text is accepted. */
export const BUSINESS_TYPE_SUGGESTIONS = [
  'ecommerce', 'restaurant', 'education', 'healthcare', 'real_estate', 'travel', 'salon', 'services', 'other',
] as const

export interface WizardDraft {
  website_url: string
  business_name: string
  business_type: string
  instructions: string
  tone: AgentTone | null
  greeting: string
  /** Comma or newline separated, as typed. */
  keywords: string
  on_low_confidence: boolean
  confidence_threshold: number
  max_turns_before_handoff: number
}

export function profileToDraft(p: AgentProfile): WizardDraft {
  return {
    website_url: p.website_url ?? '',
    business_name: p.business_name ?? '',
    business_type: p.business_type ?? '',
    instructions: p.instructions ?? '',
    tone: p.tone,
    greeting: p.greeting ?? '',
    keywords: p.handoff_rules.keywords.join(', '),
    on_low_confidence: p.handoff_rules.on_low_confidence,
    confidence_threshold: p.handoff_rules.confidence_threshold,
    max_turns_before_handoff: p.handoff_rules.max_turns_before_handoff,
  }
}

/** Split typed keywords on commas/newlines, trim, lower-case and dedupe (the server normalises again). */
export function parseKeywords(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/[,\n]/)) {
    const k = raw.trim().toLowerCase().replace(/\s+/g, ' ')
    if (k && !out.includes(k)) out.push(k)
  }
  return out
}

const clampInt = (n: number, min: number, max: number) => (Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min)

/** The PUT /api/ai/agent-profile body for the fields one step edits. */
export function draftToInput(d: WizardDraft, step: WizardStep): Record<string, unknown> {
  switch (step) {
    case 'business':
      return { website_url: d.website_url, business_name: d.business_name, business_type: d.business_type }
    case 'instructions':
      return { instructions: d.instructions, tone: d.tone }
    case 'greeting':
      return { greeting: d.greeting }
    case 'handoff': {
      const rules: HandoffRules = {
        keywords: parseKeywords(d.keywords),
        on_low_confidence: d.on_low_confidence,
        confidence_threshold: Math.min(1, Math.max(0, Number.isFinite(d.confidence_threshold) ? d.confidence_threshold : 0.35)),
        max_turns_before_handoff: clampInt(d.max_turns_before_handoff, 0, 50),
      }
      return { handoff_rules: rules }
    }
    default:
      return {}
  }
}

/** Everything the wizard edits, for the final save. */
export function fullDraftInput(d: WizardDraft): Record<string, unknown> {
  return {
    ...draftToInput(d, 'business'),
    ...draftToInput(d, 'instructions'),
    ...draftToInput(d, 'greeting'),
    ...draftToInput(d, 'handoff'),
  }
}
