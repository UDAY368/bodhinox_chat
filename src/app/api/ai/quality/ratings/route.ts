// PUT /api/ai/quality/ratings (admins and owners, 'ai.settings', rate limited) — rate one AI reply
//   as the signed-in member: { kind: 'suggestion' | 'agent', id, vote: 'up' | 'down' | null }
//   (null clears the member's rating). 200 { ok: true }; 400 invalid; 404 when the reply is not a
//   reply suggestion or sent agent reply of this workspace. Session and CSRF are enforced by the proxy.

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { requirePermission } from '@/lib/auth/permissions'
import { tenantOf } from '@/lib/audience/http'
import { withTenant } from '@/lib/db/tenant'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { parseRating, setRating } from '@/lib/ai/quality-dashboard'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')
    await requirePermission(tenantOf(ctx), 'ai.settings')
    const limit = checkRateLimit(`ai-ratings:${ctx.userId}`, { limit: 120, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit)
    const rating = parseRating(await request.json().catch(() => null))
    if (!rating) return NextResponse.json({ error: t('common.invalidRequestBody'), code: 'invalid_input' }, { status: 400 })
    const ok = await withTenant(tenantOf(ctx), (tx) => setRating(tx, ctx.accountId, ctx.userId, rating, rating.vote))
    if (!ok) return NextResponse.json({ error: t('common.notFound'), code: 'not_found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
