// GET   /api/commerce/orders/[id] — one order with its items (agents and above). 200 { order }.
// PATCH /api/commerce/orders/[id] { status?, note? } — move the order along its allowed
//   transitions and/or set the internal note (agents and above). 200 { order };
//   400 bad body; 409 { code: 'bad_transition' | 'conflict' }. Another account's id is a 404.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getOrder, orderErrorResponse, parseOrderPatch, updateOrder } from '@/lib/commerce/orders';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('agent');
    return NextResponse.json({ order: await getOrder(tenantOf(ctx), id) });
  } catch (error) {
    return orderErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`orders:write:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);
    const patch = parseOrderPatch(await request.json().catch(() => null));
    return NextResponse.json({ order: await updateOrder(tenantOf(ctx), id, patch) });
  } catch (error) {
    return orderErrorResponse(error);
  }
}
