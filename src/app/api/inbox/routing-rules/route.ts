// GET /api/inbox/routing-rules (admins and owners) — rules in evaluation order:
//   200 { rules: RoutingRule[] }.
// POST /api/inbox/routing-rules (admins and owners) — { name, enabled?, conditions,
//   assign_to, reassign_after_minutes? }; added last. 201 { rule }; 400 { error, code };
//   409 { code: 'limit' } at MAX_ROUTING_RULES.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { createRoutingRule, listRoutingRules, parseRoutingRuleInput } from '@/lib/inbox/routing';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { noStore, routingError } from '@/lib/inbox/routing-http';

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    return NextResponse.json({ rules: await listRoutingRules(tenantOf(ctx)) }, { headers: noStore });
  } catch (error) {
    return routingError(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`routingRules:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseRoutingRuleInput(await request.json().catch(() => null));
    return NextResponse.json({ rule: await createRoutingRule(tenantOf(ctx), input) }, { status: 201, headers: noStore });
  } catch (error) {
    return routingError(error);
  }
}
