// POST /api/ai/knowledge/ask — "Ask the knowledge base": the best knowledge match for a question,
//   as the AI would find it (agents and above, rate limited like the playground).
//   { question: 1..200 characters }
//   200 { match: { text, question, match (0..100), document_title,
//         source: { id, title, kind, qa, customer_facing } | null } | null }; 400.
// No model call and nothing stored or logged. Below admin, admin-only sources are never matched.

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { askKnowledge, parseAskQuestion } from '@/lib/ai/knowledge-ask'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const limit = checkRateLimit(`ai-knowledge-ask:${ctx.userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)
    const question = parseAskQuestion(await request.json().catch(() => null))
    if (!question) return NextResponse.json({ error: t('common.invalidRequestBody'), code: 'invalid_input' }, { status: 400 })
    const match = await askKnowledge(ctx, question)
    return NextResponse.json({ match }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
