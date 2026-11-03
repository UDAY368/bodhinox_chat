// POST /api/commerce/orders/[id]/cancel-refund { note?, refunded_outside? } — "Cancel and refund" a paid order that is
//   not dispatched (agents and above with commerce.refunds, admin ceiling). Requests a refund of what
//   is still refundable on each settled Razorpay payment, then cancels. Money Razorpay does not hold (an offline
//   payment, or a legacy order with no payment record) needs refunded_outside: true, the staff's confirmation it was
//   returned outside the app (409 offline_payment otherwise; nothing is requested). 200 { refund_ids, refunded_outside }; 403; 409.

import { NextResponse } from 'next/server';

import { cancelAndRefund } from '@/lib/commerce/order-lifecycle';
import { jsonBody, lifecycleErrorResponse, NO_STORE, staffContext, writeLimit } from '../../_lib/http';

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await staffContext();
    const limited = writeLimit(ctx);
    if (limited) return limited;
    const body = await jsonBody(request);
    const { refundIds, refundedOutside } = await cancelAndRefund(ctx, id, {
      note: typeof body.note === 'string' ? body.note : null, refundedOutside: body.refunded_outside === true,
    });
    return NextResponse.json({ refund_ids: refundIds, refunded_outside: refundedOutside }, { headers: NO_STORE });
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}
