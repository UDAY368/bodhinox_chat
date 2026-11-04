// GET   /api/commerce/orders/[id] — one order with its items (agents and above). 200 { order }, where order also
//   carries `shipment` (the courier shipment, or null) and `evidence` ('provider' | 'staff' | 'unknown' for a
//   dispatched or delivered order, else null: how that step is known, design §2 "Evidence label").
// PATCH /api/commerce/orders/[id] { status?, note? } — move the order along its allowed
//   transitions and/or set the internal note (agents and above). 200 { order };
//   400 bad body; 409 { code: 'bad_transition' | 'conflict' }. Another account's id is a 404.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getOrderFulfilment } from '@/lib/commerce/order-lifecycle';
import { getOrder, orderErrorResponse, parseOrderPatch, updateOrder } from '@/lib/commerce/orders';
import { maskEmbeddedContact, resolvePhoneMask } from '@/lib/inbox/masking-apply';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('agent');
    const order = await getOrder(tenantOf(ctx), id);
    const fulfilment = await getOrderFulfilment(tenantOf(ctx), id);
    return NextResponse.json(
      { order: { ...maskEmbeddedContact(order, await resolvePhoneMask(tenantOf(ctx))), ...fulfilment } },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
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
    const order = await updateOrder(tenantOf(ctx), id, patch);
    return NextResponse.json({ order: maskEmbeddedContact(order, await resolvePhoneMask(tenantOf(ctx))) });
  } catch (error) {
    return orderErrorResponse(error);
  }
}
