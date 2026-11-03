import { NextResponse } from 'next/server'
import { getT } from '@/lib/i18n/translate'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  answerUnanswered,
  dismissUnanswered,
  promoteToKnowledge,
  UnansweredError,
} from '@/lib/ai/unanswered'

const t = getT('Api')

type Params = { params: Promise<{ id: string }> }

const notFound = () => NextResponse.json({ error: t('common.notFound') }, { status: 404 })

/**
 * POST /api/ai/unanswered/[id] (agent+; promote is admin+)
 *
 * Body, one of:
 *   { action: 'answer', answer: string }  save or edit the team's answer
 *   { action: 'dismiss' }                 drop an open question
 *   { action: 'promote', answer: string } teach an answered question to the agent
 *                                         (creates or updates a knowledge document);
 *                                         `answer` is the text the admin reviewed, and
 *                                         a 409 means an agent changed it since
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { db, accountId, userId, role } = await requireRole('agent')
    const limit = checkRateLimit(`ai-unanswered:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null) as { action?: unknown; answer?: unknown } | null
    const ctx = { accountId, userId, role }

    switch (body?.action) {
      case 'answer': {
        const question = await answerUnanswered(ctx, id, { answer: body.answer })
        return question ? NextResponse.json({ question }) : notFound()
      }
      case 'dismiss':
        return (await dismissUnanswered(ctx, id)) ? NextResponse.json({ success: true }) : notFound()
      case 'promote': {
        const result = await promoteToKnowledge(ctx, id, db, body.answer)
        return result ? NextResponse.json(result) : notFound()
      }
      default:
        return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 })
    }
  } catch (err) {
    if (err instanceof UnansweredError) return NextResponse.json({ error: err.message }, { status: err.status })
    return toErrorResponse(err)
  }
}
