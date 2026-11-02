// PUT /api/inbox/routing-rules/{id} (admins and owners) — replaces a rule's name,
//   enabled, conditions, assign_to and reassign_after_minutes (position is kept).
//   200 { rule }; 400 { error, code }; 404 { code: 'not_found' } (also another workspace's id).
// DELETE /api/inbox/routing-rules/{id} (admins and owners) — 200 { ok: true }; 404.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { deleteRoutingRule, parseRoutingRuleInput, updateRoutingRule } from '@/lib/inbox/routing';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { noStore, routingError } from '@/lib/inbox/routing-http';

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`routingRules:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseRoutingRuleInput(await request.json().catch(() => null));
    return NextResponse.json({ rule: await updateRoutingRule(tenantOf(ctx), id, input) }, { headers: noStore });
  } catch (error) {
    return routingError(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`routingRules:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);
    await deleteRoutingRule(tenantOf(ctx), id);
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch (error) {
    return routingError(error);
  }
}
