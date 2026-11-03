// GET  /api/commerce/orders/[id]/returns — the order's returns (agents and above). 200 { returns }.
// POST /api/commerce/orders/[id]/returns { items: [{ order_item_id, qty }], note? } — open a return
//   on a dispatched or delivered order (agents and above). 201 { return }; 400; 409.

import { NextResponse } from 'next/server';

import { createReturn, listOrderReturns } from '@/lib/commerce/returns';
import { jsonBody, lifecycleErrorResponse, NO_STORE, staffContext, writeLimit } from '../../_lib/http';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await staffContext();
    return NextResponse.json({ returns: await listOrderReturns(ctx, id) }, { headers: NO_STORE });
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
    const created = await createReturn(ctx, id, { items: body.items, note: body.note });
    return NextResponse.json({ return: created }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}
