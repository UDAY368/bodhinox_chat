// PATCH  /api/sequences/:id/messages/:messageId — { delay_amount?, delay_unit?, active?, flow_id? } (agent or above).
// DELETE /api/sequences/:id/messages/:messageId — remove it and close the gap (agent or above);
//   409 busy while the worker is sending this sequence to someone.
// 200 { sequence }; 400 invalid_request; 404 notFound | flowNotFound.
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import {
  deleteMessage,
  parseMessagePatch,
  requireInstagram,
  sequenceErrorResponse,
  sequenceHeaders,
  SEQUENCE_WRITE_LIMIT,
  updateMessage,
} from '@/lib/sequences/store';

type Params = { params: Promise<{ id: string; messageId: string }> };

async function guard() {
  const ctx = await requireRole('agent');
  requireInstagram();
  const limit = checkRateLimit(`sequences:write:${ctx.userId}`, SEQUENCE_WRITE_LIMIT);
  return { ctx, limited: limit.success ? null : rateLimitResponse(limit) };
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id, messageId } = await params;
    const { ctx, limited } = await guard();
    if (limited) return limited;
    const patch = parseMessagePatch(await request.json().catch(() => null));
    return NextResponse.json({ sequence: await updateMessage(tenantOf(ctx), id, messageId, patch) }, { headers: sequenceHeaders });
  } catch (error) {
    return sequenceErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { id, messageId } = await params;
    const { ctx, limited } = await guard();
    if (limited) return limited;
    return NextResponse.json({ sequence: await deleteMessage(tenantOf(ctx), id, messageId) }, { headers: sequenceHeaders });
  } catch (error) {
    return sequenceErrorResponse(error);
  }
}
