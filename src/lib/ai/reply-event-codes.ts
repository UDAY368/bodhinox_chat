// Outcome and reason codes of the AI activity log (ai_reply_events), shared by
// the recorder, the admin API and the Activity tab. Client-safe: no server
// imports. Reasons are short codes, never text from a message or an error.

export const REPLY_EVENT_OUTCOMES = ['replied', 'handed_off', 'skipped', 'error'] as const
export type ReplyEventOutcome = (typeof REPLY_EVENT_OUTCOMES)[number]

/** Every reason the auto-reply agent records, by outcome. */
export const REPLY_EVENT_REASONS = {
  replied: ['answered', 'answered_low_confidence'],
  handed_off: [
    'handoff_keyword', 'max_turns', 'sensitive_topic', 'guard_blocked',
    'low_confidence', 'model_handoff', 'no_answer', 'empty_reply',
  ],
  skipped: [
    'automation_active', 'number_disconnected', 'reply_cap', 'no_messages', 'rate_limited',
    'plan_ai_limit', 'slot_lost', 'claim_failed', 'stale', 'rate_limited_retry',
  ],
  error: ['dispatch_failed'],
} as const satisfies Record<ReplyEventOutcome, readonly string[]>

export type ReplyEventReason = (typeof REPLY_EVENT_REASONS)[ReplyEventOutcome][number]

export const ALL_REPLY_EVENT_REASONS: readonly ReplyEventReason[] = REPLY_EVENT_OUTCOMES.flatMap((o) => REPLY_EVENT_REASONS[o])

export const REASON_CODE = /^[a-z0-9_]{1,64}$/

export const isReplyEventOutcome = (value: unknown): value is ReplyEventOutcome =>
  typeof value === 'string' && (REPLY_EVENT_OUTCOMES as readonly string[]).includes(value)
