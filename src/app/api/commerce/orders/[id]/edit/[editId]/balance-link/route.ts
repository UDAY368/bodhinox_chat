// POST /api/commerce/orders/[id]/edit/[editId]/balance-link — create (or find) the Razorpay payment link for the
//   balance an order edit left due (agents and above with commerce.checkout). Safe to repeat: the link's reference
//   is derived from the edit, so a second call returns the same link; nothing is sent to the customer.
//   200 { payment_state }: link_created | link_failed | link_unknown | link_paid; 404; 409 conflict (a later edit
//   replaced this one, or the order is cancelled).
// CSRF: session mutations pass the proxy's assertMutation.

import { NextResponse } from 'next/server';

import { ensureBalanceLink, OrderEditError } from '@/lib/commerce/order-edits';
import { lifecycleErrorResponse, NO_STORE, staffContext, writeLimit } from '../../../../_lib/http';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string; editId: string }> };

export async function POST(_request: Request, context: Context) {
  try {
    const { id, editId } = await context.params;
    const ctx = await staffContext();
    const limited = writeLimit(ctx);
    if (limited) return limited;
    return NextResponse.json({ payment_state: await ensureBalanceLink(ctx, id, editId) }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof OrderEditError)
      return NextResponse.json({ error: 'Order edit refused', code: error.code }, { status: error.status, headers: NO_STORE });
    return lifecycleErrorResponse(error);
  }
}
