import type { DataClient } from '@/lib/data/types'
import type { ChatMessage } from './types'
import { logAiEvent } from './log'

/** Safety reasons the AI hands a conversation to staff. */
export type HandoffGuardReason = 'sensitive_topic' | 'guard_blocked'

const GUARD_NOTE: Record<HandoffGuardReason, string> = {
  sensitive_topic: 'Sensitive or health topic: route to qualified staff.',
  guard_blocked: 'Its answer was withheld by a safety check: please reply yourself.',
}

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160

/**
 * Build the short internal note the auto-reply bot leaves on a
 * conversation when it hands off to a human. Deterministic — composed
 * from context we already have (no extra LLM call / token spend), so it
 * can't fail or add latency to the handoff.
 *
 * Reads as, e.g.:
 *   "🤖 AI agent handed off after 2 replies. Last customer message:
 *    “can I speak to a manager about my refund?”"
 *
 * `replyCount` is the bot's auto-reply tally for the thread (0 when it
 * bailed on the very first inbound without answering).
 */
export function buildHandoffSummary(args: {
  messages: ChatMessage[]
  replyCount: number
  /** Why the AI stood down when a safety guard decided it (shown to staff). */
  reason?: HandoffGuardReason
}): string {
  const { messages, replyCount } = args

  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.content.trim())

  const replies =
    replyCount === 0
      ? 'without replying'
      : `after ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`

  const base = `🤖 AI agent handed off ${replies}.${args.reason ? ` ${GUARD_NOTE[args.reason]}` : ''}`

  if (!lastCustomer) return base

  const quote = truncate(lastCustomer.content.trim(), MAX_QUOTE_LEN)
  return `${base} Last customer message: “${quote}”`
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ')
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}

/**
 * Hands the conversation to staff: stops AI replies and the bot
 * (ai_autoreply_disabled, bot_paused), leaves the internal note
 * (ai_handoff_summary, ai_handoff_at) and assigns the handoff agent when one
 * is configured (which fires the assignment notification). Shared by the
 * inbox auto-reply and the flow ai_reply step.
 *
 * Ownership is compared at the UPDATE itself: a conversation a human already
 * owns (assigned, paused, AI off) is never touched. `observedCustomerAt`
 * (auto-reply) also requires the customer's latest message time to be the one
 * the caller read, inside the 24 h window. Best-effort: never throws.
 */
export async function pauseConversationForStaff(db: DataClient, args: {
  accountId: string
  conversationId: string
  contactId: string
  summary: string
  handoffAgentId?: string | null
  observedCustomerAt?: string | null
}): Promise<void> {
  const update: Record<string, unknown> = {
    ai_autoreply_disabled: true, bot_paused: true, ai_handoff_summary: args.summary,
    // Analytics counts handoffs by this time; resuming AI keeps it.
    ai_handoff_at: new Date().toISOString(),
  }
  if (args.handoffAgentId) update.assigned_agent_id = args.handoffAgentId
  try {
    let query = db.from('conversations').update(update)
      .eq('id', args.conversationId).eq('account_id', args.accountId).eq('contact_id', args.contactId)
      .is('assigned_agent_id', null).eq('bot_paused', false).eq('ai_autoreply_disabled', false)
    if (args.observedCustomerAt !== undefined) {
      query = query.eq('last_customer_message_at', args.observedCustomerAt)
        .gt('last_customer_message_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    }
    const { error } = await query
    if (error) logAiEvent({ feature: 'handoff', reason: 'pause_failed', accountId: args.accountId })
  } catch (error) {
    logAiEvent({ feature: 'handoff', reason: 'pause_failed', accountId: args.accountId, error })
  }
}
