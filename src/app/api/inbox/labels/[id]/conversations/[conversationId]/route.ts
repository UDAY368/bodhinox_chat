// PUT    /api/inbox/labels/:id/conversations/:conversationId (agents and above) — apply the label.
// DELETE /api/inbox/labels/:id/conversations/:conversationId (agents and above) — remove it.
//   200 { ok: true } (both idempotent); 404 when the label or the conversation is not in this
//   workspace, or the caller may not see the conversation (agent visibility).
// CSRF/mutation origin is enforced by src/proxy.ts.
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { LABEL_WRITE_LIMIT, labelErrorResponse, setConversationLabel } from '@/lib/inbox/labels';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string; conversationId: string }> };

async function apply(on: boolean, { params }: Params) {
  try {
    const { id, conversationId } = await params;
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`inbox:labels:${ctx.userId}`, LABEL_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    await setConversationLabel(tenantOf(ctx), id, conversationId, on);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return labelErrorResponse(error);
  }
}

export async function PUT(_request: Request, context: Params) {
  return apply(true, context);
}

export async function DELETE(_request: Request, context: Params) {
  return apply(false, context);
}
