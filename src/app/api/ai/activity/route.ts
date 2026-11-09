// GET /api/ai/activity (admins and owners) — the AI activity log: what the
//   WhatsApp auto-reply agent did with each customer message, newest first.
//   Query: outcome (replied | handed_off | skipped | error), reason (code),
//   contact_id (uuid), from/to (ISO), cursor (from next_cursor), limit (1-100, default 50).
//   200 { events: [{ id, created_at, conversation_id, contact, outcome, reason, preview,
//         has_reply, model, total_tokens, latency_ms }], next_cursor }; 400 invalid query.
//   preview is the first 160 characters of the customer's message; the full
//   text and the reply come from GET /api/ai/activity/[id].

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { tenantOf } from '@/lib/audience/http'
import { getT } from '@/lib/i18n/translate'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { ActivityQueryError, listReplyEvents, parseActivityQuery } from '@/lib/ai/reply-events'

const t = getT('Api')
const noStore = { 'Cache-Control': 'private, no-store' }

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`ai-activity:${ctx.userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)
    const query = parseActivityQuery(new URL(request.url).searchParams)
    return NextResponse.json(await listReplyEvents(tenantOf(ctx), query), { headers: noStore })
  } catch (error) {
    if (error instanceof ActivityQueryError) {
      return NextResponse.json({ error: t('ai.activityQueryInvalid'), code: 'invalid_query' }, { status: 400, headers: noStore })
    }
    return toErrorResponse(error)
  }
}
