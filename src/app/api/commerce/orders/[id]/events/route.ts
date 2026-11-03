// GET /api/commerce/orders/[id]/events — the order's timeline: status history and lifecycle events,
//   its receipts and credit notes, and its customer notice outcomes (agents and above).
//   200 { events, documents, messages }; another account's id is a 404.

import { NextResponse } from 'next/server';

import { getOrderTimeline } from '@/lib/commerce/order-lifecycle';
import { lifecycleErrorResponse, NO_STORE, staffContext } from '../../_lib/http';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await staffContext();
    return NextResponse.json(await getOrderTimeline(ctx, id), { headers: NO_STORE });
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}
