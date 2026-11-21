// POST /api/sequences/:id/messages — add a message at the end (agent or above):
//   { flow_id }            an existing Instagram automation of this workspace, or
//   { create: { name } }   a new draft Instagram automation to build, or, on a WhatsApp sequence,
//   { whatsapp: { text?, media?: { type, url, filename? }, template?: { name, language?, params? } | null },
//     delay_amount?, delay_unit? }
//                          the step's message, the approved template sent when the 24-hour window is closed, and
//                          optionally when it is sent (else right away for the first message, a day later after that).
//   201 { sequence }; 400 invalid_request | templateUnusable; 404 notFound | flowNotFound | templateNotFound;
//   409 tooManyMessages (50).
// PUT  /api/sequences/:id/messages — { order: [message ids] }, every message exactly once (agent or above).
//   200 { sequence }; 400 invalid_request.
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import {
  addMessage,
  parseMessageCreate,
  reorderMessages,
  sequenceErrorResponse,
  sequenceHeaders,
  SEQUENCE_WRITE_LIMIT,
} from '@/lib/sequences/store';

type Params = { params: Promise<{ id: string }> };

async function guard() {
  const ctx = await requireRole('agent');
  const limit = await checkRateLimit(`sequences:write:${ctx.userId}`, SEQUENCE_WRITE_LIMIT);
  return { ctx, limited: limit.success ? null : rateLimitResponse(limit) };
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { ctx, limited } = await guard();
    if (limited) return limited;
    const input = parseMessageCreate(await request.json().catch(() => null));
    return NextResponse.json({ sequence: await addMessage(tenantOf(ctx), id, input) }, { status: 201, headers: sequenceHeaders });
  } catch (error) {
    return sequenceErrorResponse(error);
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { ctx, limited } = await guard();
    if (limited) return limited;
    const body = (await request.json().catch(() => null)) as { order?: unknown } | null;
    return NextResponse.json({ sequence: await reorderMessages(tenantOf(ctx), id, body?.order) }, { headers: sequenceHeaders });
  } catch (error) {
    return sequenceErrorResponse(error);
  }
}
