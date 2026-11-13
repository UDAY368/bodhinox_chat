import { databaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledgeScored } from './knowledge'
import { generateReply } from './generate'
import { buildAgentSystemPrompt, loadAgentProfileTx, matchHandoffKeyword, type AgentProfile } from './agent-profile'
import { agentProfileFor, pickAgent } from './agents'
import { assessConfidence, type RetrievalScores } from './confidence'
import { recordUnanswered } from './unanswered'
import { buildHandoffSummary, pauseConversationForStaff, type HandoffGuardReason } from './handoff'
import { logAiEvent } from './log'
import { classifySensitive, hasUncoveredScript } from './safety/sensitive'
import { guardCustomerText, isHealthWorkspace, redactChat, urlAllowlist } from './assist/guards'
import { promptCharsOf, usageLog } from './usage'
import { chatTokenEstimate, failAi, releaseAi, reserveAi, settleAi, type AiReservation } from './budget'
import { latestUserMessage, recentCustomerText } from './query'
import { recordReplyEvent, type ReplyEventInput } from './reply-events'
import type { ConfidenceReason } from './confidence'
import type { ReplyEventOutcome, ReplyEventReason } from './reply-event-codes'
import { getSessionWindow } from '@/lib/inbox/session'
import {
  conversationNumberDisconnected,
  engineSendText,
  loadAccountMetaCredentials,
} from '@/lib/flows/meta-send'
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import type { PreparedInstagramAiReply } from './instagram-send'
import type { AiConfig } from './types'
import { BotRepliesPausedError } from '@/lib/whatsapp/bot-pause-error'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { PlanLimitError } from '@/lib/billing/entitlements'
import { newRequestKey } from '@/lib/billing/usage-ledger'
import { getWorkerPrisma } from '@/lib/db/prisma'
import { withTenant } from '@/lib/db/tenant'
import { enqueueJob } from '@/lib/jobs/queue'

/** The delayed retry of an inbound the account-wide AI rate limit deferred. */
export const AI_AUTO_REPLY_RETRY_JOB = 'ai.auto_reply_retry'
/** Deferred retries per inbound before it is left for a person, as before. */
export const MAX_RATE_LIMIT_RETRIES = 5
/** Customer message types the agent can read; media and locations after a text never supersede it. */
const AI_READABLE_TYPES = ['text', 'interactive', 'template']

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
  /** Set by the rate-limit retry job: how many times this inbound was deferred. */
  retryAttempt?: number
  /** The inbound's messages.id. Required to defer it: the retry job runs under
   *  that message's inbound stage checkpoint, so it is never sent twice. */
  inboundRowId?: string
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
    retryAttempt = 0,
  } = args

  let db: ReturnType<typeof databaseAdmin>
  try {
    db = databaseAdmin({ accountId, userId: configOwnerUserId, role: 'owner' })
  } catch (error) {
    console.error('[ai auto-reply] client initialization failed', { error: error instanceof Error ? error.name : 'unknown' })
    return
  }
  const readConversation = () => aiOwnedConversation(db, accountId, conversationId, contactId)
  // Ownership checks are repeated after generation and immediately before send.
  // A newer customer message the agent can read supersedes this one (with an
  // inbound id; otherwise the conversation's customer timestamp decides). A
  // photo, voice note or location sent after the text does not: the text
  // still gets its answer.
  let observedCustomerTimestamp: string | undefined
  const eligible = async () => {
    const conversation = await readConversation()
    if (!conversation || (!inboundMessageId && observedCustomerTimestamp && conversation.last_customer_message_at !== observedCustomerTimestamp)) return null
    if (inboundMessageId) {
      const { data: latest, error } = await db.from('messages').select('message_id')
        .eq('conversation_id', conversationId).eq('sender_type', 'customer').in('content_type', AI_READABLE_TYPES)
        .order('created_at', { ascending: false }).order('arrival_sequence', { ascending: false }).limit(1).maybeSingle()
      if (error || latest?.message_id !== inboundMessageId) return null
    }
    return conversation
  }
  const pauseForHuman = async (summary: string, handoffAgentId?: string | null) => {
    const current = await eligible()
    if (!current) return
    await pauseConversationForStaff(db, {
      accountId, conversationId, contactId, summary, handoffAgentId,
      observedCustomerAt: current.last_customer_message_at,
    })
  }
  const unavailable = async () => {
    if (requireHandoffOnUnavailable) await pauseForHuman('AI agent handed off: AI assistance is unavailable. A human should review the latest customer message.')
  }

  // The AI activity log: exactly one row per dispatch that passed the first
  // eligibility check, written at its terminal point (best-effort, never throws).
  const started = Date.now()
  const event: Omit<ReplyEventInput, 'outcome' | 'reason'> = {
    accountId, conversationId, contactId, inboundMessageId: inboundMessageId ?? null,
  }
  let recorded = false
  const record = async (outcome: ReplyEventOutcome, reason: ReplyEventReason, extra: Partial<ReplyEventInput> = {}) => {
    if (recorded) return
    recorded = true
    await recordReplyEvent({ ...event, ...extra, outcome, reason, latencyMs: Date.now() - started })
  }
  let gatePassed = false
  // Set when the sender's last ownership check refuses, so the catch below records 'stale'.
  let staleBeforeSend = false
  // Set once Meta accepted the reply: a later failure (saving it locally) still means the customer got it.
  let sentReply: { text: string; reason: ReplyEventReason } | null = null
  // The conversation's channel, from its row (never the caller): Instagram replies use the Instagram sender.
  let instagram = false
  let instagramSend: typeof import('./instagram-send') | null = null

  try {
    const config = await loadAiConfig(db, accountId)
    // Each channel has its own switch (checked below, from the conversation row).
    if (!config || (!config.autoReplyEnabled && !config.instagramAutoReplyEnabled)) { await unavailable(); return }

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
    if (autoResponders && autoResponders.length > 0) {
      // Logged only for a thread the agent would otherwise have answered.
      if (await eligible()) await record('skipped', 'automation_active')
      return
    }

    const conv = await eligible()
    if (!conv) return
    instagram = conv.channel === 'instagram'
    if (!autoReplyOn(config, conv.channel)) { await unavailable(); return }
    gatePassed = true
    // The thread's number was disconnected: replies are refused, never sent from
    // another number. Stand down quietly (no handoff, no LLM call); the reason
    // code is logged, never the content.
    if (!instagram && await conversationNumberDisconnected(db, accountId, conversationId)) {
      console.info('[ai auto-reply] skipped', { reason: 'whatsapp_number_disconnected' })
      await record('skipped', 'number_disconnected')
      return
    }
    // Instagram: the account, its token and permission, and the window, before any model call.
    if (instagram) {
      // Loaded only for Instagram threads, so the WhatsApp path's module graph is unchanged.
      instagramSend = await import('./instagram-send')
      try {
        await instagramSend.assertInstagramAiReady(accountId, conversationId)
      } catch (error) {
        const code = instagramSend.instagramRefusalCode(error)
        if (!code) throw error
        console.info('[ai auto-reply] skipped', { reason: code })
        await record('skipped', code === 'instagram_window_closed' ? 'stale' : 'number_disconnected')
        return
      }
    }
    observedCustomerTimestamp = conv.last_customer_message_at
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) { await unavailable(); await record('skipped', 'reply_cap'); return }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) { await unavailable(); await record('skipped', 'no_messages'); return }

    // The workspace's agent profile (setup wizard). Missing or unreadable
    // means the defaults: no keywords, no turn limit.
    const profile = await loadProfile(accountId)
    // Exactly one agent answers: the conversation's previous agent when it is
    // still on for this channel and hour, else the first eligible agent in
    // list order. Agents exist but none is on now: a person answers. Not
    // best-effort: a failed read throws (an agent that is off never answers).
    const pick = await pickAgent(accountId, instagram ? 'instagram' : 'whatsapp', conversationId)
    if (pick.kind === 'none') {
      console.info('[ai auto-reply] skipped', { reason: 'no_agent' })
      await unavailable()
      await record('skipped', 'no_agent')
      return
    }
    const agent = pick.kind === 'agent' ? pick.agent : null
    event.agentId = agent?.id ?? null
    // The default agent replies with the workspace profile exactly as before.
    const agentProfile = agent ? agentProfileFor(profile, agent) : profile
    const rules = agentProfile?.handoff_rules
    const question = latestUserMessage(messages)
    event.customerText = question
    // Routing checks every customer turn since the last reply, so a burst
    // ("<health question>", then "hello??") is still routed to staff.
    const recent = recentCustomerText(messages)
    const handOff = (reason?: HandoffGuardReason) => pauseForHuman(
      buildHandoffSummary({ messages, replyCount: conv.ai_reply_count ?? 0, reason }),
      config.handoffAgentId,
    )
    // Operator handoff rules run before any model call: a keyword in the
    // customer's message, or the AI has already replied enough times.
    if (rules && matchHandoffKeyword(recent, rules)) {
      console.info('[ai auto-reply] handed off', { reason: 'handoff_keyword' })
      await handOff()
      await record('handed_off', 'handoff_keyword')
      return
    }
    if (rules && rules.max_turns_before_handoff > 0 && (conv.ai_reply_count ?? 0) >= rules.max_turns_before_handoff) {
      console.info('[ai auto-reply] handed off', { reason: 'max_turns' })
      await handOff()
      await record('handed_off', 'max_turns')
      return
    }
    // A health or safety-sensitive question goes to qualified staff, before
    // any model call (the existing handoff: summary note plus assignment).
    if (classifySensitive(recent).sensitive) {
      logAiEvent({ feature: 'auto_reply', reason: 'sensitive_topic', accountId })
      await handOff('sensitive_topic')
      await record('handed_off', 'sensitive_topic')
      return
    }

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → the
    // inbound is retried by a delayed job after the window (eligible()
    // drops it then if a newer message or a person took over); after
    // MAX_RATE_LIMIT_RETRIES it is left for a person, as before.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      logAiEvent({ feature: 'auto_reply', reason: 'rate_limited', accountId })
      if (await deferRateLimited(args, retryAttempt, acctLimit.reset)) {
        await record('skipped', 'rate_limited_retry')
        return
      }
      await unavailable()
      await record('skipped', 'rate_limited')
      return
    }

    // The plan's monthly AI messages and tokens, held for this inbound message
    // (one meter per message, however often it is replayed): when used up, the
    // inbound waits for a human. The token hold is the conversation plus the
    // output cap; it settles to the provider's actual usage.
    let reservation: AiReservation
    try {
      reservation = await reserveAi(accountId, inboundMessageId ? `inbound:${inboundMessageId}` : newRequestKey(),
        { message: true, tokens: chatTokenEstimate(config.systemPrompt ?? '', messages) }, getWorkerPrisma())
    } catch (error) {
      if (!(error instanceof PlanLimitError)) throw error
      console.info('[ai auto-reply] skipped', { reason: 'plan_ai_limit' })
      await unavailable()
      await record('skipped', 'plan_ai_limit')
      return
    }

    // Every gate has passed — we're committed to attempting a reply, so
    // show the customer "typing…" (and mark their message read) while the
    // retrieval + LLM round trips run. Meta clears the indicator after
    // 25 s or when our reply lands, whichever is first, so there's
    // nothing to undo on the handoff / no-text path. Strictly
    // best-effort: a failed indicator must never cost us the reply.
    // WhatsApp only: the indicator is a WhatsApp Cloud API call.
    if (inboundMessageId && !instagram) {
      await showTypingIndicator(db, accountId, conversationId, inboundMessageId)
    }

    // Stage 5 (5G): the workspace's Instagram goals. With none set (the
    // default) nothing changes. Lead details in this message are captured
    // first; a declined lead goal set to hand off goes to a person.
    let goalGuidance: { instructions: string; allowedUrls: string[] } | null = null
    if (instagram) {
      const { instagramAutoReplyGoals } = await import('./goals')
      const goals = await instagramAutoReplyGoals({
        accountId, conversationId, contactId, inboundMessageId: inboundMessageId ?? null, latestText: question,
      })
      if (goals.kind === 'handoff') {
        await releaseAi(reservation)
        await handOff()
        await record('handed_off', 'model_handoff')
        return
      }
      if (goals.kind === 'instructions') goalGuidance = goals
    }

    // Ground the reply in the account's knowledge base (best-effort). The
    // search reads every customer turn since the last reply, so a question
    // split over two messages ("Do you deliver to Pune?", "and how much?")
    // still finds its page. Turns already answered are left out: their
    // matches would lift the confidence score of an unrelated new question.
    const { chunks, retrieval, citations } = await retrieveKnowledgeScored(
      db,
      accountId,
      config,
      recent,
      5,
      'customer',
    )
    const knowledge = chunks.map((c) => c.content)

    // Platform rules first, then the operator's profile, then knowledge
    // quoted as untrusted reference material (see agent-profile.ts).
    // A goal's guidance joins the operator instructions (never customer text).
    const goalText = goalGuidance?.instructions ?? null
    const promptProfile = agentProfile && goalText
      ? { ...agentProfile, instructions: [agentProfile.instructions?.trim() || config.systemPrompt?.trim() || '', goalText].filter(Boolean).join('\n\n') }
      : agentProfile
    const systemPrompt = buildAgentSystemPrompt(promptProfile, {
      mode: 'auto_reply',
      knowledge,
      legacyPrompt: goalText && !agentProfile ? [config.systemPrompt?.trim(), goalText].filter(Boolean).join('\n\n') : config.systemPrompt,
      agent: agent && !agent.is_default ? { name: agent.name, role: agent.role } : null,
    })

    // Personal data in customer messages is masked before it leaves for the provider.
    event.provider = config.provider
    event.model = config.model
    event.sources = citations ?? []
    let generated: Awaited<ReturnType<typeof generateReply>>
    try {
      generated = await generateReply({
        config,
        systemPrompt,
        messages: redactChat(messages).messages,
      })
    } catch (error) {
      await failAi(reservation, error, promptCharsOf(systemPrompt, messages))
      throw error
    }
    const { text: rawText, handoff, noAnswer, usage } = generated

    // Settle the AI message and the tokens spent on the account's BYO key
    // (with the ai_usage_log row), whatever happens next: the provider call
    // happened either way. settleAi never throws.
    const log = usageLog({
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
      estimate: { promptChars: promptCharsOf(systemPrompt, messages), outputChars: rawText.length },
    })
    await settleAi(reservation, { tokens: log.totalTokens, log })
    Object.assign(event, { promptTokens: log.promptTokens, completionTokens: log.completionTokens, totalTokens: log.totalTokens })

    if (!await eligible()) { await record('skipped', 'stale'); return }

    // Both control phrases are stripped (parseGeneration and
    // assessConfidence) before anything can be sent.
    const confidence = assessConfidence({
      reply: rawText,
      handoff,
      noAnswer,
      retrieval,
      threshold: autoReplyThreshold(rules?.confidence_threshold ?? 0, retrieval),
    })
    event.confidence = confidence.score
    let text = confidence.text
    const lowConfidence = confidence.reason === 'low_score' && (rules?.on_low_confidence ?? false)
    const handingOff = !confidence.confident && (confidence.reason !== 'low_score' || lowConfidence)
    // The question the agent could not answer goes to the Learnings list
    // (stored, never logged).
    if (handingOff) await noteUnanswered(accountId, question, conversationId, contactId)

    if (!handingOff) {
      // Output guards: no medical advice, no claim that a payment, refund,
      // attendance, shipment or delivery happened, no unreadable script for a
      // health-type workspace, and only allowed links. A blocked answer is
      // never sent; the conversation goes to a human instead.
      const health = hasUncoveredScript(text) ? await healthWorkspace(accountId, profile) : false
      const allow = urlAllowlist({ citations, profile, legacyPrompt: config.systemPrompt })
      const guarded = guardCustomerText(text, {
        allow: goalGuidance?.allowedUrls.length ? { ...allow, urls: [...allow.urls, ...goalGuidance.allowedUrls] } : allow,
        healthWorkspace: health,
      })
      if (!guarded.ok) {
        logAiEvent({ feature: 'auto_reply', reason: 'guard_blocked', accountId, flags: guarded.flags })
        await handOff('guard_blocked')
        await record('handed_off', 'guard_blocked', { guardFlags: guarded.flags })
        return
      }
      text = guarded.text
      event.guardFlags = guarded.flags
      if (!text.trim()) { await handOff('guard_blocked'); await record('handed_off', 'guard_blocked'); return }
    }

    if (handingOff) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      await handOff()
      await record('handed_off', CONFIDENCE_HANDOFF_REASON[confidence.reason])
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
      await record('skipped', 'claim_failed')
      return
    }
    if (claimed !== true) { await unavailable(); await record('skipped', 'slot_lost'); return }

    if (!await eligible()) { await record('skipped', 'stale'); return }
    // The sender repeats this after credentials/recipient lookup and on retries.
    const beforeSend = async () => {
      if (!await eligible()) {
        staleBeforeSend = true
        throw new Error('AI conversation eligibility changed before sending')
      }
    }

    const repliedReason: ReplyEventReason = confidence.confident ? 'answered' : 'answered_low_confidence'
    const onSent = () => { sentReply = { text, reason: repliedReason } }
    if (instagramSend) {
      // The Instagram sender: window, account and the 1000-byte limit, checked
      // before the send (a refusal is a certain "not sent").
      let prepared: PreparedInstagramAiReply
      try {
        prepared = await instagramSend.prepareInstagramAiReply(accountId, conversationId, text)
      } catch (error) {
        const code = instagramSend.instagramRefusalCode(error)
        if (!code) throw error
        console.info('[ai auto-reply] skipped', { reason: code })
        // An answer over Instagram's text limit is withheld, like a guarded one: a person answers.
        if (code === 'invalid_request') { await handOff('guard_blocked'); await record('handed_off', 'guard_blocked'); return }
        await record('skipped', code === 'instagram_window_closed' ? 'stale' : 'number_disconnected')
        return
      }
      await instagramSend.sendInstagramAiReply(prepared, { beforeSend, onSent })
    } else {
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text,
        aiGenerated: true,
        beforeSend,
        onSent,
      })
    }
    await record('replied', repliedReason, { replyText: text })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed', { error: err instanceof Error ? err.name : 'unknown' })
    try { await unavailable() } catch (handoffError) {
      console.error('[ai auto-reply] unavailable handoff failed', { error: handoffError instanceof Error ? handoffError.name : 'unknown' })
    }
    // Never the error message: a reason code only. An agent pausing the bot
    // during the send is an ownership change, like the sender's last check.
    const reply = sentReply as { text: string; reason: ReplyEventReason } | null
    if (!gatePassed) return
    if (reply) await record('replied', reply.reason, { replyText: reply.text })
    else if (staleBeforeSend || err instanceof BotRepliesPausedError) await record('skipped', 'stale')
    else await record('error', 'dispatch_failed')
  }
}

/**
 * The conversation when the AI may answer in it: no person owns it, the bot is
 * on and the 24-hour window is open (the same window on WhatsApp and Instagram).
 */
async function aiOwnedConversation(db: ReturnType<typeof databaseAdmin>, accountId: string, conversationId: string, contactId: string) {
  const { data, error } = await db.from('conversations')
    .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count, bot_paused, last_customer_message_at, channel')
    .eq('id', conversationId).eq('account_id', accountId).eq('contact_id', contactId).maybeSingle()
  if (error || !data || data.assigned_agent_id || data.bot_paused || data.ai_autoreply_disabled) return null
  if (!getSessionWindow(data.last_customer_message_at, Date.now()).active) {
    // Reason code only: an Instagram thread past its window gets nothing automated.
    if (data.channel === 'instagram') console.info('[ai auto-reply] skipped', { reason: 'instagram_window_closed' })
    return null
  }
  return data
}

/** The auto-reply switch of the conversation's channel (legacy rows without a channel are WhatsApp). */
const autoReplyOn = (config: AiConfig, channel: unknown): boolean =>
  channel === 'instagram' ? config.instagramAutoReplyEnabled === true : config.autoReplyEnabled

/**
 * A photo, voice note, video, document or location the agent cannot read,
 * in a conversation it would otherwise answer: one 'skipped / media_only'
 * activity-log row, so the owner can see why the AI stayed quiet. Nothing is
 * sent and nothing is handed off (the inbox lifecycle already queues the
 * conversation for a person). Best-effort: never throws, logs reason codes only.
 */
export async function recordUnreadableInbound(args: Pick<DispatchArgs, 'accountId' | 'conversationId' | 'contactId' | 'configOwnerUserId' | 'inboundMessageId'>): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId, inboundMessageId } = args
  try {
    const db = databaseAdmin({ accountId, userId: configOwnerUserId, role: 'owner' })
    const config = await loadAiConfig(db, accountId)
    if (!config || (!config.autoReplyEnabled && !config.instagramAutoReplyEnabled)) return
    const conversation = await aiOwnedConversation(db, accountId, conversationId, contactId)
    if (!conversation || !autoReplyOn(config, conversation.channel)) return
    await recordReplyEvent({ accountId, conversationId, contactId, inboundMessageId: inboundMessageId ?? null, outcome: 'skipped', reason: 'media_only' })
  } catch (error) {
    logAiEvent({ feature: 'auto_reply', reason: 'media_only_record_failed', accountId, error })
  }
}

/**
 * Queue the delayed retry of a rate-limited inbound, run just after the
 * limiter's window resets. True when queued; false when there is nothing to
 * retry against (no inbound ids), the retries are used up, or the enqueue
 * failed (logged as a reason code only).
 */
async function deferRateLimited(args: DispatchArgs, attempt: number, resetAt: number): Promise<boolean> {
  if (!args.inboundMessageId || !args.inboundRowId || attempt >= MAX_RATE_LIMIT_RETRIES) return false
  const next = attempt + 1
  const delayMs = Math.max(5_000, resetAt - Date.now()) + Math.floor(Math.random() * 5_000)
  try {
    await enqueueJob(AI_AUTO_REPLY_RETRY_JOB, {
      conversationId: args.conversationId,
      contactId: args.contactId,
      configOwnerUserId: args.configOwnerUserId,
      inboundMessageId: args.inboundMessageId,
      messageId: args.inboundRowId,
      requireHandoffOnUnavailable: args.requireHandoffOnUnavailable === true,
      attempt: next,
    }, {
      tenantId: args.accountId,
      runAt: new Date(Date.now() + delayMs),
      dedupeKey: `ai-autoreply-retry:${args.inboundMessageId}:${next}`,
      maxAttempts: 3,
    })
    return true
  } catch (error) {
    logAiEvent({ feature: 'auto_reply', reason: 'retry_enqueue_failed', accountId: args.accountId, error })
    return false
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The 'ai.auto_reply_retry' job: re-run the dispatch for the deferred inbound.
 * It runs under the inbound's stage checkpoint `ai_reply_retry:<attempt>`, so a
 * job leased again after a crash or an expired lease mid-send stops for
 * reconciliation instead of sending the reply a second time.
 */
export async function handleAutoReplyRetryJob(accountId: string, payload: Record<string, unknown>, assertLease: () => void = () => {}): Promise<void> {
  const { conversationId, contactId, configOwnerUserId, inboundMessageId, messageId, attempt } = payload
  if (typeof conversationId !== 'string' || !UUID.test(conversationId)
    || typeof contactId !== 'string' || !UUID.test(contactId)
    || typeof configOwnerUserId !== 'string' || !UUID.test(configOwnerUserId)
    || typeof messageId !== 'string' || !UUID.test(messageId)
    || typeof inboundMessageId !== 'string' || !inboundMessageId || inboundMessageId.length > 256
    || typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1 || attempt > MAX_RATE_LIMIT_RETRIES) throw new Error('Invalid AI auto-reply retry payload')
  const { runInboundStage } = await import('@/lib/whatsapp/ingest')
  await runInboundStage(accountId, messageId, `ai_reply_retry:${attempt}`, () => dispatchInboundToAiReply({
    accountId, conversationId, contactId, configOwnerUserId, inboundMessageId,
    inboundRowId: messageId,
    routingChecked: true,
    requireHandoffOnUnavailable: payload.requireHandoffOnUnavailable === true,
    retryAttempt: attempt,
  }), assertLease)
}

/** The activity-log reason for a handoff decided by assessConfidence. */
const CONFIDENCE_HANDOFF_REASON: Record<ConfidenceReason, ReplyEventReason> = {
  low_score: 'low_confidence',
  handoff: 'model_handoff',
  no_answer: 'no_answer',
  empty: 'empty_reply',
  // Not reached (an answered turn is never handed off); kept so every reason maps.
  answered: 'low_confidence',
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

/** Health-type workspace (fail closed: true when it cannot be read). */
async function healthWorkspace(accountId: string, profile: AgentProfile | null): Promise<boolean> {
  try {
    return await withTenant({ accountId, role: 'owner' }, (tx) => isHealthWorkspace(tx, accountId, profile), getWorkerPrisma())
  } catch {
    return true
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
