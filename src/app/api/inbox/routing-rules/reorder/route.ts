// POST /api/inbox/routing-rules/reorder (admins and owners) — { ids: string[] }, every
//   rule exactly once, first evaluated first. 200 { rules }; 400 { code: 'invalid_order' }.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { parseRuleOrder, reorderRoutingRules } from '@/lib/inbox/routing';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { noStore, routingError } from '@/lib/inbox/routing-http';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`routingRules:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);
    const ids = parseRuleOrder(await request.json().catch(() => null));
    return NextResponse.json({ rules: await reorderRoutingRules(tenantOf(ctx), ids) }, { headers: noStore });
  } catch (error) {
    return routingError(error);
  }
}
