// GET /api/ai/quality/dashboard?filter=all|suggestion|agent|down|unrated (admins and owners,
//   'ai.settings') — the AI page's Quality tab for the last 30 days:
//   200 { window_days, outcomes: { accepted, edited, rejected, unused }, daily: [{ day, shown }],
//         safety: [{ check, count }], ratings: { up, down }, replies: [QualityReply] (≤ 50, filtered) }.
//   Holds customer text (questions and replies), so it is admin-only like the activity log.

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { requirePermission } from '@/lib/auth/permissions'
import { tenantOf } from '@/lib/audience/http'
import { withTenant } from '@/lib/db/tenant'
import { parseReplyFilter, readQualityDashboard } from '@/lib/ai/quality-dashboard'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    await requirePermission(tenantOf(ctx), 'ai.settings')
    const filter = parseReplyFilter(new URL(request.url).searchParams.get('filter'))
    const view = await withTenant(tenantOf(ctx), (tx) => readQualityDashboard(tx, ctx.accountId, ctx.userId, filter))
    return NextResponse.json(view, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
