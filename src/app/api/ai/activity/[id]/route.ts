// GET /api/ai/activity/[id] (admins and owners) — one AI activity row in full:
//   the customer's message, the reply, knowledge sources, confidence, guard
//   flags, provider/model, tokens and latency. 404 when the id is not in the
//   caller's workspace (or is malformed).

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { tenantOf } from '@/lib/audience/http'
import { getT } from '@/lib/i18n/translate'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getReplyEvent } from '@/lib/ai/reply-events'

const t = getT('Api')
const noStore = { 'Cache-Control': 'private, no-store' }

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`ai-activity:${ctx.userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params
    const event = await getReplyEvent(tenantOf(ctx), id)
    if (!event) return NextResponse.json({ error: t('ai.activityNotFound') }, { status: 404, headers: noStore })
    return NextResponse.json({ event }, { headers: noStore })
  } catch (error) {
    return toErrorResponse(error)
  }
}
