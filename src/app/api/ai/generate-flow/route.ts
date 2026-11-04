import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { logAiUsage } from '@/lib/ai/usage'
import { databaseAdmin } from '@/lib/ai/admin-client'
import { AiError } from '@/lib/ai/types'
import { FLOW_GOAL_MAX, generateFlowDraft, insertDraftFlow } from '@/lib/ai/flow-generator'
import { getT } from '@/lib/i18n/translate'
import { recordAiMessage, requireAiMessageRoom } from '@/lib/billing/limits'

const t = getT('Api')

/**
 * POST /api/ai/generate-flow  (agent+, the same role that creates flows)
 *
 * Body: { goal: string }
 * Returns 201 { flow, issues } — a new DRAFT flow (never activated) built
 * from the goal, plus any activation issues left after one corrective
 * retry so the builder can point at them. Each model call is billed as one
 * AI message. The goal, prompt and model output are never logged.
 */
export async function POST(request: Request) {
  try {
    const { db, accountId, userId } = await requireRole('agent')

    const userLimit = checkRateLimit(`ai-generate-flow:${userId}`, RATE_LIMITS.aiDraft)
    if (!userLimit.success) return rateLimitResponse(userLimit)
    const accountLimit = checkRateLimit(`ai-draft-acct:${accountId}`, RATE_LIMITS.aiDraftAccount)
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

    const body = await request.json().catch(() => null)
    const goal = body && typeof body.goal === 'string' ? body.goal.trim() : ''
    if (!goal) {
      return NextResponse.json({ error: t('aiAssist.goalRequired'), code: 'goal_required' }, { status: 400 })
    }
    if (goal.length > FLOW_GOAL_MAX) {
      return NextResponse.json({ error: t('aiAssist.goalTooLong', { max: FLOW_GOAL_MAX }), code: 'goal_too_long' }, { status: 400 })
    }

    const config = await loadAiConfig(db, accountId, { requireActive: false }).catch(() => {
      throw new AiError(t('ai.storedKeyUndecryptable'), { code: 'key_decrypt_failed', status: 400 })
    })
    if (!config) {
      return NextResponse.json({ error: t('ai.noAgentConfigured'), code: 'ai_not_configured' }, { status: 400 })
    }

    const { data: tagRows } = await db.from('tags').select('id,name').is('archived_at', null).limit(100)
    const tags = ((tagRows ?? []) as Array<{ id: string; name: string }>).filter((r) => typeof r.id === 'string' && typeof r.name === 'string')

    const { flow, issues } = await generateFlowDraft({
      config,
      goal,
      context: { tags },
      hooks: {
        beforeAttempt: () => requireAiMessageRoom(accountId),
        afterAttempt: async (usage, estimate) => {
          await recordAiMessage(accountId)
          try {
            void logAiUsage(databaseAdmin({ accountId, userId, role: 'agent' }), {
              accountId,
              conversationId: null,
              mode: 'draft',
              provider: config.provider,
              model: config.model,
              usage,
              estimate,
            })
          } catch {
            console.error('[ai/generate-flow] usage log skipped')
          }
        },
      },
    })

    const created = await insertDraftFlow(db, { accountId, userId }, flow)
    return NextResponse.json({ flow: created, issues }, { status: 201 })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
