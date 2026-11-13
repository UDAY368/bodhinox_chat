// GET /api/ai/budget (admins and owners, 'ai.settings') — the monthly token budget card:
//   200 { used, cap, plan_limit, limit, pause_at_cap, resets_at, by_mode: [{ mode, tokens }], state }.
//   Read-only. The cap and the pause switch are changed with PUT /api/ai/settings
//   ({ monthly_token_cap, pause_at_cap }).

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { requirePermission } from '@/lib/auth/permissions'
import { tenantOf } from '@/lib/audience/http'
import { withTenant } from '@/lib/db/tenant'
import { readBudgetView } from '@/lib/ai/budget-view'

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    await requirePermission(tenantOf(ctx), 'ai.settings')
    const view = await withTenant(tenantOf(ctx), (tx) => readBudgetView(tx, ctx.accountId))
    return NextResponse.json(view, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
