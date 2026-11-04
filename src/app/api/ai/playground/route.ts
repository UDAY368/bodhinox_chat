import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { retrieveKnowledgeScored } from '@/lib/ai/knowledge'
import { generateReply } from '@/lib/ai/generate'
import { buildAgentSystemPrompt, loadAgentProfile, matchHandoffKeyword, type AgentProfile } from '@/lib/ai/agent-profile'
import { assessConfidence } from '@/lib/ai/confidence'
import { autoReplyThreshold } from '@/lib/ai/auto-reply'
import { latestUserMessage } from '@/lib/ai/query'
import { AiError, type ChatMessage } from '@/lib/ai/types'
import { getT } from '@/lib/i18n/translate'
import { recordAiMessage, requireAiMessageRoom } from '@/lib/billing/limits'
import { aiDeploymentEnabled } from '@/lib/ai/gate'

const t = getT('Api')

// Keep the tested transcript bounded, mirroring the live context window.
const MAX_TURNS = 20

/**
 * POST /api/ai/playground  (agent+)
 *
 * Test-chat with the account's agent WITHOUT touching WhatsApp. Runs the
 * same decision path the auto-reply bot uses: the agent profile's handoff
 * keywords and turn limit, knowledge-base retrieval, the agent profile
 * prompt (the legacy prompt when no profile was saved), the configured
 * provider and the confidence decision. What you see here is what a real
 * customer would get; `reason` and `score` say why. Reads the config
 * even when the master switch is off (requireActive:false) so you can
 * try it before going live. Stateless: the client sends the running
 * transcript each turn.
 */
export async function POST(request: Request) {
  const startedAt = performance.now()
  try {
    const { db, accountId, userId, role } = await requireRole('agent')

    const limit = checkRateLimit(`ai-playground:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const rawMessages = Array.isArray(body?.messages) ? body.messages : null
    if (!rawMessages) {
      return NextResponse.json({ error: t('ai.messagesRequired') }, { status: 400 })
    }

    const messages: ChatMessage[] = rawMessages
      .filter(
        (m: unknown): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          ((m as ChatMessage).role === 'user' ||
            (m as ChatMessage).role === 'assistant') &&
          typeof (m as ChatMessage).content === 'string' &&
          (m as ChatMessage).content.trim().length > 0,
      )
      .slice(-MAX_TURNS)

    if (messages.length === 0) {
      return NextResponse.json(
        { error: t('ai.sendMessageToTest') },
        { status: 400 },
      )
    }

    // Deployment kill switch (AI_ENABLED=false): say so instead of "not configured".
    if (!aiDeploymentEnabled()) {
      return NextResponse.json({ error: t('ai.aiDisabled'), code: 'ai_disabled' }, { status: 503 })
    }

    const config = await loadAiConfig(db, accountId, {
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/playground] loadAiConfig error', { error: err instanceof Error ? err.name : 'unknown' })
      throw new AiError(t('ai.storedKeyUndecryptable'), {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: t('ai.noAgentConfigured'),
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    // The live auto-reply reads the profile best-effort; so does the playground.
    const profile: AgentProfile | null = await loadAgentProfile({ accountId, userId, role }).catch(() => null)
    const rules = profile?.handoff_rules
    const question = latestUserMessage(messages)
    const diagnostics = (timing: { knowledgeMatches: number; retrievalMs: number; generationMs: number }) => ({
      model: config.model,
      ...timing,
      totalMs: Math.round(performance.now() - startedAt),
    })

    // Operator handoff rules run before any model call, as in auto-reply.
    const aiReplies = messages.filter((m) => m.role === 'assistant').length
    const ruleHandoff = rules && matchHandoffKeyword(question, rules)
      ? 'handoff_keyword'
      : rules && rules.max_turns_before_handoff > 0 && aiReplies >= rules.max_turns_before_handoff
        ? 'max_turns'
        : null
    if (ruleHandoff) {
      return NextResponse.json({
        reply: '', handoff: true, reason: ruleHandoff, score: 0,
        diagnostics: diagnostics({ knowledgeMatches: 0, retrievalMs: 0, generationMs: 0 }),
      })
    }

    const retrievalStartedAt = performance.now()
    // The playground previews the customer agent, so it retrieves what customers may be shown.
    const { chunks, retrieval } = await retrieveKnowledgeScored(db, accountId, config, question, 5, 'customer')
    const knowledge = chunks.map((c) => c.content)
    const retrievalMs = Math.round(performance.now() - retrievalStartedAt)
    const systemPrompt = buildAgentSystemPrompt(profile, {
      mode: 'auto_reply',
      knowledge,
      legacyPrompt: config.systemPrompt,
    })

    const generationStartedAt = performance.now()
    await requireAiMessageRoom(accountId)
    const { text: rawText, handoff, noAnswer } = await generateReply({ config, systemPrompt, messages })
    await recordAiMessage(accountId)
    const confidence = assessConfidence({
      reply: rawText,
      handoff,
      noAnswer,
      retrieval,
      threshold: autoReplyThreshold(rules?.confidence_threshold ?? 0, retrieval),
    })
    const lowConfidence = confidence.reason === 'low_score' && (rules?.on_low_confidence ?? false)
    const handingOff = !confidence.confident && (confidence.reason !== 'low_score' || lowConfidence)
    return NextResponse.json({
      // On a handoff the live bot sends nothing.
      reply: handingOff ? '' : confidence.text,
      handoff: handingOff,
      reason: confidence.reason,
      score: confidence.score,
      diagnostics: diagnostics({
        knowledgeMatches: knowledge.length,
        retrievalMs,
        generationMs: Math.round(performance.now() - generationStartedAt),
      }),
    })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
