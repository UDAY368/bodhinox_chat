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
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { generateReply } from './generate'
import { latestUserMessage } from './query'
import { logAiUsage } from './usage'
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
import type { AiConfig } from './types'
import type { DataClient } from '@/lib/data/types'
import { getSessionWindow } from '@/lib/inbox/session'
import { conversationNumberDisconnected, engineSendText } from '@/lib/flows/meta-send'
import { dispatchOnce } from '@/lib/jobs/dispatch'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { PlanLimitError } from '@/lib/billing/entitlements'
import { recordAiMessage, requireAiMessageRoom } from '@/lib/billing/limits'
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

export type FlowAiHandoffReason = Exclude<ConfidenceReason, 'answered'> | 'keyword'

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
}

interface ConversationRow {
  bot_paused: boolean
  ai_autoreply_disabled: boolean
  ai_reply_count: number
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
      .select('bot_paused, ai_autoreply_disabled, ai_reply_count, last_customer_message_at')
      .eq('id', conversationId).eq('account_id', accountId).eq('contact_id', contactId).maybeSingle()
    if (error || !data) return 'conversation_unavailable'
    const row = data as ConversationRow
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

    let decision: TurnDecision
    if (generationIntent) {
      decision = generationIntent.result as TurnDecision
    } else {
      const conversation = await readConversation()
      if (typeof conversation === 'string') return unavailable(conversation)
      // A disconnected number refuses replies; never send from another number.
      if (await conversationNumberDisconnected(db, accountId, conversationId)) return unavailable('number_disconnected')
      if ((conversation.ai_reply_count ?? 0) >= config.autoReplyMaxPerConversation) return unavailable('reply_cap')

      const messages = await buildConversationContext(db, conversationId)
      const question = latestUserMessage(messages)
      if (!messages.length || !question.trim()) return unavailable('no_question')

      const profile = await loadProfile(accountId)
      const rules = profile?.handoff_rules ?? DEFAULT_HANDOFF_RULES
      // Operator handoff keywords win before any model call.
      if (matchHandoffKeyword(question, rules)) return { kind: 'handoff', reason: 'keyword', score: 0, citations: [] }

      // Shared with the inbox auto-reply: bounds a burst on the account's key.
      if (!checkRateLimit(`ai-autoreply:${accountId}`, RATE_LIMITS.aiAutoReplyAccount).success) return unavailable('rate_limited')
      try {
        await requireAiMessageRoom(accountId, getWorkerPrisma())
      } catch (error) {
        if (error instanceof PlanLimitError) return unavailable('plan_limit')
        throw error
      }

      const useKnowledge = args.config.use_knowledge !== false
      const knowledge = useKnowledge
        ? await retrieveFlowKnowledge(db, accountId, config, question)
        : { excerpts: [], retrieval: null, citations: [] }
      const lowScoreHandsOff = typeof args.config.confidence_threshold === 'number' || rules.on_low_confidence

      const systemPrompt = buildAgentSystemPrompt(withStepInstructions(profile, config, args.config.instructions), {
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
            result = await generateReply({ config, systemPrompt, messages })
          } catch (error) {
            console.warn('[ai flow reply] generation failed', { error: error instanceof Error ? error.name : 'unknown' })
            return { decision: 'unavailable', reason: 'generation_failed' }
          }
          await recordAiMessage(accountId, getWorkerPrisma())
          void logAiUsage(db, { accountId, conversationId, mode: 'auto_reply', provider: config.provider, model: config.model, usage: result.usage })

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
          return { decision: 'answer', text: confidence.text, score: confidence.score, citations: knowledge.citations }
        })
      } catch (error) {
        if (isUncertain(error)) return unavailable('turn_uncertain')
        throw error
      }
    }

    if (decision.decision === 'unavailable') return unavailable(decision.reason)
    if (decision.decision === 'handoff') {
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
    try {
      const sent = await dispatchOnce(accountId, args.intentKey, async (): Promise<SentTurn> => ({
        ...(await engineSendText({
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
): AgentProfile {
  const base = profile ?? emptyAgentProfile()
  const general = base.instructions?.trim() || config.systemPrompt?.trim() || ''
  const step = typeof stepInstructions === 'string' ? stepInstructions.trim().slice(0, AI_REPLY_LIMITS.instructions) : ''
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
  const { chunks, retrieval } = await retrieveKnowledgeScored(db, accountId, config, queryText, k)
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
