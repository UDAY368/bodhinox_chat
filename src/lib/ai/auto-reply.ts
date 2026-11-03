import { databaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledgeScored } from './knowledge'
import { generateReply } from './generate'
import { buildAgentSystemPrompt, loadAgentProfileTx, matchHandoffKeyword, type AgentProfile } from './agent-profile'
import { assessConfidence, type RetrievalScores } from './confidence'
import { recordUnanswered } from './unanswered'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { getSessionWindow } from '@/lib/inbox/session'
import {
  conversationNumberDisconnected,
  engineSendText,
  loadAccountMetaCredentials,
} from '@/lib/flows/meta-send'
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { PlanLimitError } from '@/lib/billing/entitlements'
import { recordAiMessage, requireAiMessageRoom } from '@/lib/billing/limits'
import { getWorkerPrisma } from '@/lib/db/prisma'
import { withTenant } from '@/lib/db/tenant'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** Meta's wamid of the customer message we're replying to. When set,
   *  a typing indicator (which also marks it read) is shown while the
   *  reply is generated. Optional so older callers keep working. */
  inboundMessageId?: string
  /** The webhook worker already checked which deterministic responders matched. */
  routingChecked?: boolean
  /** An opted-in flow needs a human when AI cannot answer. */
  requireHandoffOnUnavailable?: boolean
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * Delayed jobs and model calls must still belong to the active customer
 * session and stand down if a human takes ownership while they run.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    inboundMessageId,
    routingChecked,
    requireHandoffOnUnavailable,
  } = args

  let db: ReturnType<typeof databaseAdmin>
  try {
    db = databaseAdmin({ accountId, userId: configOwnerUserId, role: 'owner' })
  } catch (error) {
    console.error('[ai auto-reply] client initialization failed', { error: error instanceof Error ? error.name : 'unknown' })
    return
  }
  const readConversation = async () => {
    const { data, error } = await db.from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count, bot_paused, last_customer_message_at')
      .eq('id', conversationId).eq('account_id', accountId).eq('contact_id', contactId).maybeSingle()
    if (error || !data || data.assigned_agent_id || data.bot_paused || data.ai_autoreply_disabled || !getSessionWindow(data.last_customer_message_at, Date.now()).active) return null
    return data
  }
  // Ownership checks are repeated after generation and immediately before send.
  // The timestamp also rejects a draft built before a newer customer message.
  let observedCustomerTimestamp: string | undefined
  const eligible = async () => {
    const conversation = await readConversation()
    if (!conversation || (observedCustomerTimestamp && conversation.last_customer_message_at !== observedCustomerTimestamp)) return null
    if (inboundMessageId) {
      const { data: latest, error } = await db.from('messages').select('message_id')
        .eq('conversation_id', conversationId).eq('sender_type', 'customer')
        .order('created_at', { ascending: false }).order('arrival_sequence', { ascending: false }).limit(1).maybeSingle()
      if (error || latest?.message_id !== inboundMessageId) return null
    }
    return conversation
  }
  const pauseForHuman = async (summary: string, handoffAgentId?: string | null) => {
    const current = await eligible()
    if (!current) return
    const update: Record<string, unknown> = {
      ai_autoreply_disabled: true, bot_paused: true, ai_handoff_summary: summary,
    }
    if (handoffAgentId) update.assigned_agent_id = handoffAgentId
    // Compare ownership at the UPDATE itself so a new human assignee wins.
    await db.from('conversations').update(update)
      .eq('id', conversationId).eq('account_id', accountId).eq('contact_id', contactId)
      .is('assigned_agent_id', null).eq('bot_paused', false).eq('ai_autoreply_disabled', false)
      .eq('last_customer_message_at', current.last_customer_message_at)
      .gt('last_customer_message_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  }
  const unavailable = async () => {
    if (requireHandoffOnUnavailable) await pauseForHuman('AI agent handed off: AI assistance is unavailable. A human should review the latest customer message.')
  }

  try {
    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) { await unavailable(); return }

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = routingChecked ? { data: [] } : await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const conv = await eligible()
    if (!conv) return
    // The thread's number was disconnected: replies are refused, never sent from
    // another number. Stand down quietly (no handoff, no LLM call); the reason
    // code is logged, never the content.
    if (await conversationNumberDisconnected(db, accountId, conversationId)) {
      console.info('[ai auto-reply] skipped', { reason: 'whatsapp_number_disconnected' })
      return
    }
    observedCustomerTimestamp = conv.last_customer_message_at
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) { await unavailable(); return }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) { await unavailable(); return }

    // The workspace's agent profile (setup wizard). Missing or unreadable
    // means the defaults: no keywords, no turn limit.
    const profile = await loadProfile(accountId)
    const rules = profile?.handoff_rules
    const question = latestUserMessage(messages)
    const handOff = () => pauseForHuman(
      buildHandoffSummary({ messages, replyCount: conv.ai_reply_count ?? 0 }),
      config.handoffAgentId,
    )
    // Operator handoff rules run before any model call: a keyword in the
    // customer's message, or the AI has already replied enough times.
    if (rules && matchHandoffKeyword(question, rules)) {
      console.info('[ai auto-reply] handed off', { reason: 'handoff_keyword' })
      await handOff()
      return
    }
    if (rules && rules.max_turns_before_handoff > 0 && (conv.ai_reply_count ?? 0) >= rules.max_turns_before_handoff) {
      console.info('[ai auto-reply] handed off', { reason: 'max_turns' })
      await handOff()
      return
    }

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      await unavailable()
      return
    }

    // The plan's monthly AI messages: when used up, the inbound waits for a human.
    try {
      await requireAiMessageRoom(accountId, getWorkerPrisma())
    } catch (error) {
      if (!(error instanceof PlanLimitError)) throw error
      console.info('[ai auto-reply] skipped', { reason: 'plan_ai_messages_used' })
      await unavailable()
      return
    }

    // Every gate has passed — we're committed to attempting a reply, so
    // show the customer "typing…" (and mark their message read) while the
    // retrieval + LLM round trips run. Meta clears the indicator after
    // 25 s or when our reply lands, whichever is first, so there's
    // nothing to undo on the handoff / no-text path. Strictly
    // best-effort: a failed indicator must never cost us the reply.
    if (inboundMessageId) {
      await showTypingIndicator(db, accountId, conversationId, inboundMessageId)
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const { chunks, retrieval } = await retrieveKnowledgeScored(
      db,
      accountId,
      config,
      question,
    )
    const knowledge = chunks.map((c) => c.content)

    // Platform rules first, then the operator's profile, then knowledge
    // quoted as untrusted reference material (see agent-profile.ts).
    const systemPrompt = buildAgentSystemPrompt(profile, {
      mode: 'auto_reply',
      knowledge,
      legacyPrompt: config.systemPrompt,
    })

    const { text: rawText, handoff, noAnswer, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    })
    await recordAiMessage(accountId, getWorkerPrisma())

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (!await eligible()) return

    // Both control phrases are stripped (parseGeneration and
    // assessConfidence) before anything can be sent.
    const confidence = assessConfidence({
      reply: rawText,
      handoff,
      noAnswer,
      retrieval,
      threshold: autoReplyThreshold(rules?.confidence_threshold ?? 0, retrieval),
    })
    const text = confidence.text
    const lowConfidence = confidence.reason === 'low_score' && (rules?.on_low_confidence ?? false)
    const handingOff = !confidence.confident && (confidence.reason !== 'low_score' || lowConfidence)
    // The question the agent could not answer goes to the Learnings list
    // (stored, never logged).
    if (handingOff) await noteUnanswered(accountId, question, conversationId, contactId)

    if (handingOff) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      await handOff()
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed', { code: (claimErr as { code?: string }).code ?? null })
      await unavailable()
      return
    }
    if (claimed !== true) { await unavailable(); return }

    if (!await eligible()) return
    // The sender repeats this after credentials/recipient lookup and on retries.
    const beforeSend = async () => {
      if (!await eligible()) throw new Error('AI conversation eligibility changed before sending')
    }

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
      beforeSend,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed', { error: err instanceof Error ? err.name : 'unknown' })
    try { await unavailable() } catch (handoffError) {
      console.error('[ai auto-reply] unavailable handoff failed', { error: handoffError instanceof Error ? handoffError.name : 'unknown' })
    }
  }
}

/**
 * The profile's threshold. Without retrieval evidence (no knowledge
 * base, or nothing matched) a threshold above 0.5 could never pass, so
 * it is capped there: the model's own control phrases decide.
 */
export function autoReplyThreshold(threshold: number, retrieval: RetrievalScores | null): number {
  const t = Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : 0
  const evidence = Boolean(retrieval && ((retrieval.semanticDistances?.length ?? 0) + (retrieval.lexicalRanks?.length ?? 0)))
  return evidence ? t : Math.min(t, 0.5)
}

/**
 * Best-effort "typing…" for the inbound we're about to answer. Swallows
 * every failure (no WhatsApp config, bad token, Meta 4xx) with a warning
 * — the indicator is cosmetic, the reply is not.
 */
async function showTypingIndicator(
  db: ReturnType<typeof databaseAdmin>,
  accountId: string,
  conversationId: string,
  inboundMessageId: string,
): Promise<void> {
  try {
    // The number the inbound arrived on: the conversation's number.
    const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
      db,
      accountId,
      conversationId,
    )
    await sendTypingIndicator({
      phoneNumberId,
      accessToken,
      messageId: inboundMessageId,
    })
  } catch (err) {
    console.warn('[ai auto-reply] typing indicator failed (continuing)', { error: err instanceof Error ? err.name : 'unknown' })
  }
}

/** The agent profile, read with the worker role. Best-effort: null on any failure. */
async function loadProfile(accountId: string): Promise<AgentProfile | null> {
  try {
    return await withTenant({ accountId, role: 'owner' }, (tx) => loadAgentProfileTx(tx, accountId), getWorkerPrisma())
  } catch (err) {
    console.warn('[ai auto-reply] agent profile unavailable (using defaults):', err instanceof Error ? err.name : 'unknown')
    return null
  }
}

/**
 * Record the customer's question for the Learnings list. Best-effort:
 * a failure never blocks the handoff. The question is customer content,
 * so only the error name is logged.
 */
async function noteUnanswered(accountId: string, question: string, conversationId: string, contactId: string): Promise<void> {
  if (!question.trim()) return
  try {
    await withTenant({ accountId, role: 'owner' },
      (tx) => recordUnanswered(tx, { accountId, question, conversationId, contactId }), getWorkerPrisma())
  } catch (err) {
    console.warn('[ai auto-reply] recording an unanswered question failed:', err instanceof Error ? err.name : 'unknown')
  }
}
