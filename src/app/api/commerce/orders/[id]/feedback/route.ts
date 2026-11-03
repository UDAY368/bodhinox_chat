// POST /api/commerce/orders/[id]/feedback { score: 1..5 } — the customer's score, recorded by
//   staff on a delivered order (agents and above). 200 { ok: true }; 400; 409 bad_transition.

import { NextResponse } from 'next/server';

import { recordFeedback } from '@/lib/commerce/order-lifecycle';
import { jsonBody, lifecycleErrorResponse, NO_STORE, staffContext, writeLimit } from '../../_lib/http';

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await staffContext();
    const limited = writeLimit(ctx);
    if (limited) return limited;
    const body = await jsonBody(request);
    await recordFeedback(ctx, id, typeof body.score === 'number' ? body.score : NaN);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}
