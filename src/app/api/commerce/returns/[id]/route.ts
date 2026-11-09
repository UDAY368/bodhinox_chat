// GET  /api/commerce/returns/[id] — one return (agents and above). 200 { return }.
// POST /api/commerce/returns/[id] — move a return along its lifecycle (agents and above):
//   { action: 'receive' } | { action: 'reject' } | { action: 'inspect', disposition: { <order_item_id>: 'restock'|'discard' } }
//   | { action: 'close', restock?: boolean } (admins) | { action: 'refund', amount_minor, note?, refunded_outside? } (commerce.refunds).
//   refunded_outside: true confirms money Razorpay does not hold (cash on delivery, a staff-recorded payment) was handed
//   back outside the app; it is then recorded as refunded at once (409 offline_payment without it).
//   200 { return } (refund: { refund_id, refunded_outside }); 400; 403; 404; 409 (return_window_closed on create).

import { NextResponse } from 'next/server';

import { OrderError } from '@/lib/commerce/orders';
import { closeReturn, getReturn, inspectReturn, receiveReturn, refundReturn, rejectReturn } from '@/lib/commerce/returns';
import { jsonBody, lifecycleErrorResponse, NO_STORE, staffContext, writeLimit } from '../../orders/_lib/http';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await staffContext();
    return NextResponse.json({ return: await getReturn(ctx, id) }, { headers: NO_STORE });
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await staffContext();
    const limited = writeLimit(ctx);
    if (limited) return limited;
    const body = await jsonBody(request);
    switch (body.action) {
      case 'receive':
        return NextResponse.json({ return: await receiveReturn(ctx, id) }, { headers: NO_STORE });
      case 'reject':
        return NextResponse.json({ return: await rejectReturn(ctx, id) }, { headers: NO_STORE });
      case 'inspect':
        return NextResponse.json({ return: await inspectReturn(ctx, id, body.disposition) }, { headers: NO_STORE });
      case 'close':
        return NextResponse.json({ return: await closeReturn(ctx, id, { restock: body.restock === true }) }, { headers: NO_STORE });
      case 'refund': {
        const amount = typeof body.amount_minor === 'number' ? body.amount_minor : NaN;
        const { refundId, refundedOutside } = await refundReturn(ctx, id, {
          amountMinor: amount, note: body.note, refundedOutside: body.refunded_outside === true,
        });
        return NextResponse.json({ refund_id: refundId, refunded_outside: refundedOutside }, { headers: NO_STORE });
      }
      default:
        throw new OrderError(400, 'invalid', 'Invalid action');
    }
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}
