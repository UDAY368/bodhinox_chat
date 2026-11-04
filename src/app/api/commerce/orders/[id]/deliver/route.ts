// POST /api/commerce/orders/[id]/deliver { from? } — staff-recorded delivery ("Delivered", evidence
//   "staff recorded"; agents and above). Queues the delivered notice, feedback request and product
//   follow-up. 200 { ok: true }; 409 bad_transition | conflict.

import { NextResponse } from 'next/server';

import { isOrderStatus } from '@/lib/commerce/order-format';
import { recordDelivery } from '@/lib/commerce/order-lifecycle';
import { OrderError } from '@/lib/commerce/orders';
import { jsonBody, lifecycleErrorResponse, NO_STORE, staffContext, writeLimit } from '../../_lib/http';

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await staffContext();
    const limited = writeLimit(ctx);
    if (limited) return limited;
    const body = await jsonBody(request);
    if (body.from !== undefined && !isOrderStatus(body.from)) throw new OrderError(400, 'invalid', 'Invalid status');
    await recordDelivery(ctx, id, { from: body.from as never });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}
