// ============================================================
// AI reply flow step: one AI agent answer inside a flow run.
//
// The engine (lib/flows/engine.ts) owns the run: where it goes next,
// its variables and events. This module owns the AI turn:
//
//   gates      AI set up and on, the conversation's bot not paused, AI
//              not switched off for the thread, the 24-hour window open,
//              the thread's number still connected, the per-conversation
//              AI reply cap, the account-wide AI throttle, the plan's AI
//              messages, and the agent profile's handoff keywords
//   retrieve   knowledge-base excerpts with their match scores and the
//              documents they came from (citations: ids, titles, urls)
//   generate   the account's provider, with the agent profile prompt
//              plus the step's instructions; retrieved text is quoted as
//              untrusted reference material (agent-profile.ts)
//   decide     assessConfidence: control phrase, empty or low score
//              hands off (and records the question for the team)
//   send       one outbound intent (dispatchOnce) from the conversation's
//              own number, re-checking the window and the pause first
//
// Retries never generate or bill twice. The turn's generation, its AI
// message count, its reply-slot claim and its decision run under their
// own intent (`<intentKey>:generation`) whose result stores the decision;
// the send intent's result stores what was sent. A retried turn replays
// those results. A turn whose generation or send outcome is ambiguous
// (intent left dispatching/unknown) comes back as `turn_uncertain` or
// `send_uncertain` for reconciliation, never as a new attempt.
//
// Never throws. Customer text, prompts, model output and keys are never
// logged; only reason codes.
// ============================================================

import { databaseAdmin } from './admin-client'
import { aiStepGuidance, STEP_GUIDANCE_MAX } from './goal-rules'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { generateReply } from './generate'
import { latestUserMessage, recentCustomerText } from './query'
import { promptCharsOf, usageLog } from './usage'
import { chatTokenEstimate, failAi, reserveAi, settleAi, type AiReservation } from './budget'
import { retrieveKnowledgeScored, type ScoredKnowledgeChunk } from './knowledge'
import {
  buildAgentSystemPrompt,
  DEFAULT_HANDOFF_RULES,
  emptyAgentProfile,
  loadAgentProfileTx,
  matchHandoffKeyword,
  type AgentProfile,
} from './agent-profile'
import { assessConfidence, type ConfidenceReason, type RetrievalScores } from './confidence'
import { recordUnanswered } from './unanswered'
import { logAiEvent } from './log'
import { classifySensitive, hasUncoveredScript } from './safety/sensitive'
import { guardCustomerText, isHealthWorkspace, redactChat, urlAllowlist } from './assist/guards'
import type { AiConfig, ChatMessage } from './types'
import { buildHandoffSummary, pauseConversationForStaff, type HandoffGuardReason } from './handoff'
import type { DataClient } from '@/lib/data/types'
import { getSessionWindow } from '@/lib/inbox/session'
import { conversationNumberDisconnected, engineSendText } from '@/lib/flows/meta-send'
import {
  assertInstagramAiReady,
  instagramRefusalCode,
  prepareInstagramAiReply,
  sendInstagramAiReply,
  type PreparedInstagramAiReply,
} from './instagram-send'
import { dispatchOnce } from '@/lib/jobs/dispatch'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { PlanLimitError } from '@/lib/billing/entitlements'
import { getWorkerPrisma } from '@/lib/db/prisma'
import { withTenant } from '@/lib/db/tenant'
import { AI_REPLY_LIMITS } from '@/lib/flows/ai-reply-node'
import type { AiReplyNodeConfig } from '@/lib/flows/types'

/** A knowledge-base document an answer drew on. Never its content. */
export interface FlowAiCitation {
  document_id: string
  title: string
  url: string | null
}

export type FlowAiUnavailableReason =
  | 'ai_not_configured'
  | 'conversation_unavailable'
  | 'bot_paused'
  | 'ai_disabled_for_conversation'
  | 'session_closed'
  | 'number_disconnected'
  | 'reply_cap'
  | 'no_question'
  | 'rate_limited'
  | 'plan_limit'
  | 'generation_failed'
  | 'send_failed'
  /** The send may have reached the customer: reconcile, never continue blindly. */
  | 'send_uncertain'
  /** An earlier attempt of this turn stopped mid-generation: reconcile, never regenerate. */
  | 'turn_uncertain'

export type FlowAiHandoffReason =
  | Exclude<ConfidenceReason, 'answered'>
  | 'keyword'
  /** A health or safety-sensitive question: qualified staff answer it (no model call). */
  | 'sensitive_topic'
  /** The answer made a forbidden claim or used an unreadable script: withheld, never sent. */
  | 'guard_blocked'

export type FlowAiOutcome =
  | { kind: 'answered'; text: string; whatsappMessageId: string; score: number; citations: FlowAiCitation[] }
  | { kind: 'handoff'; reason: FlowAiHandoffReason; score: number; citations: FlowAiCitation[] }
  | { kind: 'unavailable'; reason: FlowAiUnavailableReason }

export interface RunFlowAiReplyArgs {
  accountId: string
  /** The flow's author: audit column on the sent message, never tenancy. */
  userId: string
  conversationId: string
  contactId: string
  config: Partial<AiReplyNodeConfig>
  /** Outbound intent key: one send per run, step and turn. */
  intentKey: string
  /**
   * Stage 5 (5G): links the answer may contain besides the knowledge and
   * profile ones (an AI goal's share_link url, set by the flow author).
   */
  allowedUrls?: readonly string[]
  /**
   * Stage 5 (5G): the current goal's fixed guidance (lib/ai/goal-rules.ts).
   * Joined with the step's goal sentence, task list and context below the
   * step's own instructions.
   */
  goalGuidance?: string
}

interface ConversationRow {
  bot_paused: boolean
  ai_autoreply_disabled: boolean
  ai_reply_count: number
  channel?: string | null
  last_customer_message_at: string | null
}

const RETRIEVE_K = 5

/**
 * Whether the workspace's AI is set up and switched on, for the
 * activation check. Server only; false on any failure.
 */
export async function isAiConfiguredForFlows(accountId: string): Promise<boolean> {
  try {
    return Boolean(await loadAiConfig(databaseAdmin({ accountId, role: 'owner' }), accountId))
  } catch {
    return false
  }
}

/** Run one AI turn of an ai_reply step. Never throws. */
export async function runFlowAiReply(args: RunFlowAiReplyArgs): Promise<FlowAiOutcome> {
  const { accountId, conversationId, contactId } = args
  const unavailable = (reason: FlowAiUnavailableReason): FlowAiOutcome => {
    console.info('[ai flow reply] unavailable', { reason })
    return { kind: 'unavailable', reason }
  }
  let db: DataClient
  try {
    db = databaseAdmin({ accountId, userId: args.userId, role: 'owner' })
  } catch {
    return unavailable('conversation_unavailable')
  }

  const readConversation = async (): Promise<ConversationRow | FlowAiUnavailableReason> => {
    const { data, error } = await db.from('conversations')
      .select('bot_paused, ai_autoreply_disabled, ai_reply_count, last_customer_message_at, channel')
      .eq('id', conversationId).eq('account_id', accountId).eq('contact_id', contactId).maybeSingle()
    if (error || !data) return 'conversation_unavailable'
    const row = data as ConversationRow
    // WhatsApp, or (Stage 2) Instagram through the Instagram sender; a legacy null channel is WhatsApp.
    if (row.channel != null && row.channel !== 'whatsapp' && row.channel !== 'instagram') return 'conversation_unavailable'
    if (row.bot_paused) return 'bot_paused'
    if (row.ai_autoreply_disabled) return 'ai_disabled_for_conversation'
    if (!getSessionWindow(row.last_customer_message_at, Date.now()).active) return 'session_closed'
    return row
  }

  try {
    // A retried turn: replay what an earlier attempt already decided or sent.
    const intents = await readTurnIntents(accountId, args.intentKey)
    const sendIntent = intents.get(args.intentKey)
    if (sendIntent) return replaySend(sendIntent)
    const generationIntent = intents.get(generationKey(args.intentKey))
    if (generationIntent && generationIntent.status !== 'accepted') return unavailable('turn_uncertain')

    const config = await loadAiConfig(db, accountId)
    if (!config) return unavailable('ai_not_configured')

    // A safety handoff (health topic, withheld answer) goes to qualified
    // staff exactly like the inbox auto-reply's: AI and bot paused, the
    // internal note, and the handoff agent assigned. Whatever the step's
    // handoff port leads to afterwards, nothing answers the thread
    // automatically until a person resumes it.
    let transcript: ChatMessage[] | null = null
    const routeToStaff = async (reason: HandoffGuardReason, knownReplyCount?: number) => {
      const row = knownReplyCount === undefined ? await readConversation() : null
      const replyCount = knownReplyCount ?? (row && typeof row !== 'string' ? row.ai_reply_count ?? 0 : 0)
      const messages = transcript ?? await buildConversationContext(db, conversationId).catch(() => [] as ChatMessage[])
      await pauseConversationForStaff(db, {
        accountId, conversationId, contactId, handoffAgentId: config.handoffAgentId,
        summary: buildHandoffSummary({ messages, replyCount, reason }),
      })
    }

    let decision: TurnDecision
    if (generationIntent) {
      decision = generationIntent.result as TurnDecision
    } else {
      const conversation = await readConversation()
      if (typeof conversation === 'string') return unavailable(conversation)
      // A disconnected number (or Instagram account) refuses replies; never send from another one.
      if (conversation.channel === 'instagram') {
        const refused = await instagramUnavailable(accountId, conversationId)
        if (refused) return unavailable(refused)
      } else if (await conversationNumberDisconnected(db, accountId, conversationId)) return unavailable('number_disconnected')
      if ((conversation.ai_reply_count ?? 0) >= config.autoReplyMaxPerConversation) return unavailable('reply_cap')

      const messages = await buildConversationContext(db, conversationId)
      transcript = messages
      const question = latestUserMessage(messages)
      if (!messages.length || !question.trim()) return unavailable('no_question')

      const profile = await loadProfile(accountId)
      const rules = profile?.handoff_rules ?? DEFAULT_HANDOFF_RULES
      // Operator handoff keywords win before any model call.
      // Every customer turn since the last reply is checked, so a burst is still routed.
      const recent = recentCustomerText(messages)
      if (matchHandoffKeyword(recent, rules)) return { kind: 'handoff', reason: 'keyword', score: 0, citations: [] }
      // Health and safety-sensitive questions go to qualified staff before any model call.
      if (classifySensitive(recent).sensitive) {
        logAiEvent({ feature: 'flow_reply', reason: 'sensitive_topic', accountId })
        await routeToStaff('sensitive_topic', conversation.ai_reply_count ?? 0)
        return { kind: 'handoff', reason: 'sensitive_topic', score: 0, citations: [] }
      }

      // Shared with the inbox auto-reply: bounds a burst on the account's key.
      if (!checkRateLimit(`ai-autoreply:${accountId}`, RATE_LIMITS.aiAutoReplyAccount).success) return unavailable('rate_limited')
      // The plan's AI messages and tokens, held for this turn: the turn's
      // intent key is its source event, so a retried turn never meters twice.
      let reservation: AiReservation
      try {
        reservation = await reserveAi(accountId, args.intentKey, { message: true, tokens: chatTokenEstimate('', messages) }, getWorkerPrisma())
      } catch (error) {
        if (error instanceof PlanLimitError) return unavailable('plan_limit')
        throw error
      }

      const useKnowledge = args.config.use_knowledge !== false
      const knowledge = useKnowledge
        ? await retrieveFlowKnowledge(db, accountId, config, question)
        : { excerpts: [], retrieval: null, citations: [] as FlowAiCitation[] }
      const lowScoreHandsOff = typeof args.config.confidence_threshold === 'number' || rules.on_low_confidence

      const systemPrompt = buildAgentSystemPrompt(withStepInstructions(profile, config, args.config.instructions, aiStepGuidance(args.config, args.goalGuidance)), {
        mode: 'auto_reply',
        knowledge: knowledge.excerpts,
        noAnswerRule: lowScoreHandsOff,
      })

      // Generation, billing, the decision and the reply slot are one
      // recorded step: a crash inside it leaves the intent unresolved
      // (turn_uncertain on retry), never a second model call or charge.
      try {
        decision = await dispatchOnce(accountId, generationKey(args.intentKey), async (): Promise<TurnDecision> => {
          let result: Awaited<ReturnType<typeof generateReply>>
          try {
            // Personal data in customer messages is masked before it leaves for the provider.
            result = await generateReply({ config, systemPrompt, messages: redactChat(messages).messages })
          } catch (error) {
            console.warn('[ai flow reply] generation failed', { error: error instanceof Error ? error.name : 'unknown' })
            await failAi(reservation, error, promptCharsOf(systemPrompt, messages))
            return { decision: 'unavailable', reason: 'generation_failed' }
          }
          const log = usageLog({
            conversationId, mode: 'auto_reply', provider: config.provider, model: config.model, usage: result.usage,
            estimate: { promptChars: promptCharsOf(systemPrompt, messages), outputChars: result.text.length },
          })
          await settleAi(reservation, { tokens: log.totalTokens, log })

          const confidence = assessConfidence({
            reply: result.text,
            handoff: result.handoff,
            noAnswer: result.noAnswer,
            retrieval: knowledge.retrieval,
            threshold: stepThreshold(args.config, rules.confidence_threshold, knowledge.retrieval),
          })
          if (!confidence.confident && (confidence.reason !== 'low_score' || lowScoreHandsOff)) {
            // The question the agent could not answer goes to the team's list (stored, never logged).
            await noteUnanswered(accountId, question, conversationId, contactId)
            return { decision: 'handoff', reason: confidence.reason as FlowAiHandoffReason, score: confidence.score, citations: knowledge.citations }
          }

          // Output guards: no medical advice, no claim that a payment, refund,
          // attendance, shipment or delivery happened, no unreadable script for
          // a health-type workspace, and only allowed links. Withheld, never sent.
          const health = hasUncoveredScript(confidence.text) ? await healthWorkspace(accountId, profile) : false
          const allow = urlAllowlist({
            citations: knowledge.citations.map((c) => ({ chunk_id: '', document_id: c.document_id, source_id: null, title: c.title, source_url: c.url })),
            profile, legacyPrompt: config.systemPrompt,
          })
          const guarded = guardCustomerText(confidence.text, {
            allow: { ...allow, urls: [...allow.urls, ...(args.allowedUrls ?? []).filter((u) => /^https?:\/\//i.test(u))] },
            healthWorkspace: health,
          })
          if (!guarded.ok || !guarded.text.trim()) {
            logAiEvent({ feature: 'flow_reply', reason: 'guard_blocked', accountId, flags: guarded.flags })
            return { decision: 'handoff', reason: 'guard_blocked', score: confidence.score, citations: knowledge.citations }
          }

          // Atomically take an AI reply slot under the existing per-conversation cap.
          const { data: claimed, error: claimError } = await db.rpc('claim_ai_reply_slot', {
            conversation_id: conversationId,
            max_replies: config.autoReplyMaxPerConversation,
          })
          if (claimError) {
            console.error('[ai flow reply] reply slot claim failed', { code: (claimError as { code?: string }).code ?? null })
            return { decision: 'unavailable', reason: 'reply_cap' }
          }
          if (claimed !== true) return { decision: 'unavailable', reason: 'reply_cap' }
          return { decision: 'answer', text: guarded.text, score: confidence.score, citations: knowledge.citations }
        })
      } catch (error) {
        if (isUncertain(error)) return unavailable('turn_uncertain')
        throw error
      }
    }

    if (decision.decision === 'unavailable') return unavailable(decision.reason)
    if (decision.decision === 'handoff') {
      if (decision.reason === 'guard_blocked' || decision.reason === 'sensitive_topic') await routeToStaff(decision.reason)
      return { kind: 'handoff', reason: decision.reason, score: decision.score, citations: decision.citations }
    }

    // The window and the pause are checked before the send intent is
    // claimed (a closed window is then a certain "not sent"), and again
    // right before each send attempt.
    const ready = await readConversation()
    if (typeof ready === 'string') return unavailable(ready)
    const beforeSend = async () => {
      const current = await readConversation()
      if (typeof current === 'string') throw new Error('AI flow reply eligibility changed before sending')
    }
    const { text, score, citations } = decision
    // Instagram: the window, the account and the 1000-byte limit are checked
    // before the send intent is claimed, so a refusal is a certain "not sent".
    let instagramReply: PreparedInstagramAiReply | null = null
    if (ready.channel === 'instagram') {
      try {
        instagramReply = await prepareInstagramAiReply(accountId, conversationId, text)
      } catch (error) {
        const code = instagramRefusalCode(error)
        if (!code) throw error
        return unavailable(code === 'instagram_window_closed' ? 'session_closed' : code === 'invalid_request' ? 'send_failed' : 'number_disconnected')
      }
    }
    try {
      const sent = await dispatchOnce(accountId, args.intentKey, async (): Promise<SentTurn> => ({
        ...(instagramReply
          ? await sendInstagramAiReply(instagramReply, { beforeSend })
          : await engineSendText({
            accountId,
            userId: args.userId,
            conversationId,
            contactId,
            text,
            aiGenerated: true,
            beforeSend,
          })),
        text,
        score,
        citations,
      }))
      return replaySend({ status: 'accepted', result: sent })
    } catch (error) {
      console.warn('[ai flow reply] send failed', { error: error instanceof Error ? error.name : 'unknown' })
      return unavailable(isUncertain(error) ? 'send_uncertain' : 'send_failed')
    }
  } catch (error) {
    console.error('[ai flow reply] failed', { error: error instanceof Error ? error.name : 'unknown' })
    return unavailable('generation_failed')
  }
}

/**
 * Why an Instagram conversation cannot take an AI reply now (account or
 * window), as the step's unavailable reason; null when it can.
 */
async function instagramUnavailable(accountId: string, conversationId: string): Promise<FlowAiUnavailableReason | null> {
  try {
    await assertInstagramAiReady(accountId, conversationId)
    return null
  } catch (error) {
    const code = instagramRefusalCode(error)
    if (!code) throw error
    return code === 'instagram_window_closed' ? 'session_closed' : 'number_disconnected'
  }
}

/** What the generation intent records: the turn's decision, never the prompt. */
type TurnDecision =
  | { decision: 'answer'; text: string; score: number; citations: FlowAiCitation[] }
  | { decision: 'handoff'; reason: FlowAiHandoffReason; score: number; citations: FlowAiCitation[] }
  | { decision: 'unavailable'; reason: FlowAiUnavailableReason }

/** What the send intent records: what actually went to the customer. */
interface SentTurn {
  whatsapp_message_id: string
  text?: string
  score?: number
  citations?: FlowAiCitation[]
}

interface IntentRow { status: string; result: unknown }

const generationKey = (intentKey: string) => `${intentKey}:generation`

function isUncertain(error: unknown): boolean {
  return error instanceof Error && error.name === 'UncertainDispatchError'
}

/** The outcome of a send intent: accepted replays what was sent; anything else needs reconciliation. */
function replaySend(intent: IntentRow): FlowAiOutcome {
  if (intent.status === 'failed') {
    console.info('[ai flow reply] unavailable', { reason: 'send_failed' })
    return { kind: 'unavailable', reason: 'send_failed' }
  }
  const sent = (intent.status === 'accepted' ? intent.result : null) as SentTurn | null
  if (!sent?.whatsapp_message_id || typeof sent.text !== 'string') {
    console.info('[ai flow reply] unavailable', { reason: 'send_uncertain' })
    return { kind: 'unavailable', reason: 'send_uncertain' }
  }
  return {
    kind: 'answered',
    text: sent.text,
    whatsappMessageId: sent.whatsapp_message_id,
    score: typeof sent.score === 'number' ? sent.score : 0,
    citations: Array.isArray(sent.citations) ? sent.citations : [],
  }
}

/** This turn's generation and send intents, by key (without the account prefix). */
async function readTurnIntents(accountId: string, intentKey: string): Promise<Map<string, IntentRow>> {
  const prefixed = [intentKey, generationKey(intentKey)].map((k) => `${accountId}:${k}`)
  const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<Array<IntentRow & { idempotency_key: string }>>`
    SELECT idempotency_key, status, result FROM outbound_intents
    WHERE account_id=${accountId}::uuid AND idempotency_key IN (${prefixed[0]}, ${prefixed[1]})`, getWorkerPrisma())
  return new Map(rows.map((r) => [r.idempotency_key.slice(accountId.length + 1), { status: r.status, result: r.result }]))
}

/**
 * Whether an earlier attempt already started this AI turn (generated or
 * sent under `intentKey`). The engine uses it so a retried follow-up
 * does not claim, and count, the same turn twice.
 */
export async function flowAiTurnStarted(accountId: string, intentKey: string): Promise<boolean> {
  return (await readTurnIntents(accountId, intentKey)).size > 0
}

/**
 * The step's threshold, else the profile's. Without retrieval evidence
 * (knowledge off, or nothing matched) a threshold above 0.5 could never
 * pass, so it is capped there: the model's own control phrases decide.
 */
export function stepThreshold(
  config: Partial<AiReplyNodeConfig>,
  profileThreshold: number,
  retrieval: RetrievalScores | null,
): number {
  const raw = typeof config.confidence_threshold === 'number' && Number.isFinite(config.confidence_threshold)
    ? config.confidence_threshold
    : profileThreshold
  const threshold = Math.min(1, Math.max(0, raw))
  const evidence = Boolean(retrieval && ((retrieval.semanticDistances?.length ?? 0) + (retrieval.lexicalRanks?.length ?? 0)))
  return evidence ? threshold : Math.min(threshold, 0.5)
}

/**
 * The profile with this step's instructions appended to the operator
 * instructions, so they stay inside the operator block and below the
 * platform rules. The step's text is the flow author's, never customer
 * input, and is not interpolated with run variables.
 */
export function withStepInstructions(
  profile: AgentProfile | null,
  config: Pick<AiConfig, 'systemPrompt'>,
  stepInstructions: string | undefined,
  /** Stage 5 (5G): goal guidance, goal sentence, tasks and context (aiStepGuidance). */
  stepGuidance = '',
): AgentProfile {
  const base = profile ?? emptyAgentProfile()
  const general = base.instructions?.trim() || config.systemPrompt?.trim() || ''
  const own = typeof stepInstructions === 'string' ? stepInstructions.trim().slice(0, AI_REPLY_LIMITS.instructions) : ''
  const step = [own, stepGuidance.trim().slice(0, STEP_GUIDANCE_MAX)].filter(Boolean).join('\n\n')
  const instructions = [general, step && `For this step of the conversation:\n${step}`].filter(Boolean).join('\n\n')
  return { ...base, instructions: instructions || null }
}

/**
 * Knowledge-base excerpts for `query` with their match scores and the
 * documents they came from, from the shared scored search
 * (retrieveKnowledgeScored). Citations are deduplicated documents in
 * match order: ids, titles and source urls only. Best-effort.
 */
export async function retrieveFlowKnowledge(
  db: DataClient,
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k = RETRIEVE_K,
): Promise<{ excerpts: string[]; retrieval: RetrievalScores | null; citations: FlowAiCitation[] }> {
  // Flow answers go to customers: customer-facing sources only.
  const { chunks, retrieval } = await retrieveKnowledgeScored(db, accountId, config, queryText, k, 'customer')
  if (!chunks.length) return { excerpts: [], retrieval: null, citations: [] }
  return { excerpts: chunks.map((c) => c.content), retrieval, citations: citationsOf(chunks) }
}

/** One citation per document, in match order. */
export function citationsOf(chunks: readonly ScoredKnowledgeChunk[]): FlowAiCitation[] {
  const seen = new Set<string>()
  const out: FlowAiCitation[] = []
  for (const c of chunks) {
    if (!c.document_id || seen.has(c.document_id)) continue
    seen.add(c.document_id)
    out.push({ document_id: c.document_id, title: c.title ?? '', url: c.source_url })
  }
  return out
}

/** Health-type workspace (fail closed: true when it cannot be read). */
async function healthWorkspace(accountId: string, profile: AgentProfile | null): Promise<boolean> {
  try {
    return await withTenant({ accountId, role: 'owner' }, (tx) => isHealthWorkspace(tx, accountId, profile), getWorkerPrisma())
  } catch {
    return true
  }
}

/** The agent profile, read with the worker role. Null (defaults) on any failure. */
async function loadProfile(accountId: string): Promise<AgentProfile | null> {
  try {
    return await withTenant({ accountId, role: 'owner' }, (tx) => loadAgentProfileTx(tx, accountId), getWorkerPrisma())
  } catch (error) {
    console.warn('[ai flow reply] agent profile unavailable (using defaults)', { error: error instanceof Error ? error.name : 'unknown' })
    return null
  }
}

/** Record the question for the team's unanswered list. Best-effort; never logged. */
async function noteUnanswered(accountId: string, question: string, conversationId: string, contactId: string): Promise<void> {
  try {
    await withTenant({ accountId, role: 'owner' },
      (tx) => recordUnanswered(tx, { accountId, question, conversationId, contactId }), getWorkerPrisma())
  } catch (error) {
    console.warn('[ai flow reply] recording an unanswered question failed', { error: error instanceof Error ? error.name : 'unknown' })
  }
}
