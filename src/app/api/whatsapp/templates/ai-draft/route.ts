import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { assertMutation, requireSession } from '@/lib/auth/session'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { promptCharsOf, usageLog } from '@/lib/ai/usage'
import { failAi, reserveAi, ROUTE_GENERATION_TOKENS, settleAi, type AiUsageLog } from '@/lib/ai/budget'
import { AiError } from '@/lib/ai/types'
import { draftTemplate, parseTemplateDraftRequest } from '@/lib/whatsapp/template-ai'
import { getT } from '@/lib/i18n/translate'
import { newRequestKey } from '@/lib/billing/usage-ledger'

const t = getT('Api')

/**
 * POST /api/whatsapp/templates/ai-draft  (admin+, same as submit)
 *
 * Body: { goal, tone, category, language, business?, include_buttons? }
 * Returns: { draft } — a TemplatePayload that already passes
 * validateTemplatePayload, for the builder to load and the user to edit.
 *
 * Uses the account's configured provider/key. Never submits to Meta and
 * never saves; the only writes are the usage meters and ai_usage_log rows.
 */
export async function POST(request: Request) {
  try {
    const { db, accountId, userId } = await requireRole('admin')
    // Each call spends the account's provider key, so require the live
    // session's Origin + CSRF proof like other external actions.
    await assertMutation(request, await requireSession(request))

    // Same per-user and per-account budgets as inbox drafts, on their own
    // buckets so writing templates can't starve agents' reply drafts.
    const userLimit = checkRateLimit(`ai-template-draft:${userId}`, RATE_LIMITS.aiDraft)
    if (!userLimit.success) return rateLimitResponse(userLimit)
    const accountLimit = checkRateLimit(
      `ai-template-draft-acct:${accountId}`,
      RATE_LIMITS.aiDraftAccount,
    )
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

    const body = await request.json().catch(() => null)
    const parsed = parseTemplateDraftRequest(body)
    if (!parsed.ok) {
      return NextResponse.json(
        { error: t(`templates.aiDraft.${parsed.error}`), code: parsed.error },
        { status: 400 },
      )
    }

    const config = await loadAiConfig(db, accountId).catch((err) => {
      console.error('[templates/ai-draft] loadAiConfig error:', err)
      throw new AiError(t('ai.storedKeyUndecryptable'), {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        { error: t('templates.aiDraft.notConfigured'), code: 'ai_not_configured' },
        { status: 409 },
      )
    }

    // One AI message per request (its corrective retry included), held before
    // the first call and settled once with every call's tokens and log row.
    const reservation = await reserveAi(accountId, newRequestKey(), { message: true, tokens: ROUTE_GENERATION_TOKENS })
    // Each completed call is logged as it returns, so a corrective retry that
    // throws still meters the first (billed) call.
    const logs: AiUsageLog[] = []
    let result: Awaited<ReturnType<typeof draftTemplate>>
    try {
      result = await draftTemplate(parsed.value, async (systemPrompt, messages) => {
        const { text, usage } = await generateReply({ config, systemPrompt, messages })
        logs.push(usageLog({
          conversationId: null, mode: 'draft', provider: config.provider, model: config.model, usage,
          estimate: { promptChars: promptCharsOf(systemPrompt, messages), outputChars: text.length },
        }))
        return { text, usage }
      })
    } catch (error) {
      if (logs.length) await settleAi(reservation, { tokens: logs.reduce((n, l) => n + l.totalTokens, 0), log: logs })
      else await failAi(reservation, error, 0)
      throw error
    }
    await settleAi(reservation, { tokens: logs.reduce((n, l) => n + l.totalTokens, 0), log: logs })

    if (!result.ok) {
      return NextResponse.json(
        result.reason === 'invalid'
          ? {
              error: t('templates.aiDraft.invalidDraft', { reason: result.message ?? '' }),
              code: 'draft_invalid',
            }
          : { error: t('templates.aiDraft.unreadable'), code: 'draft_unreadable' },
        { status: 422 },
      )
    }

    return NextResponse.json({ draft: result.draft })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
