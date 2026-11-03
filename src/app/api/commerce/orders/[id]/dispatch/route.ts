// POST /api/commerce/orders/[id]/dispatch { from?, tracking_note? } — staff-recorded dispatch of a
//   paid order (agents and above). 200 { ok: true }; 400 bad note; 409 bad_transition | conflict.

import { NextResponse } from 'next/server';

import { isOrderStatus } from '@/lib/commerce/order-format';
import { recordDispatch } from '@/lib/commerce/order-lifecycle';
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
    if (body.tracking_note !== undefined && body.tracking_note !== null && typeof body.tracking_note !== 'string')
      throw new OrderError(400, 'invalid', 'Invalid tracking note');
    await recordDispatch(ctx, id, {
      from: body.from as never,
      ...(body.tracking_note !== undefined ? { trackingNote: body.tracking_note as string | null } : {}),
    });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}
