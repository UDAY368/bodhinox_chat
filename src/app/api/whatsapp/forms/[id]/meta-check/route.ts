// GET /api/whatsapp/forms/[id]/meta-check — admin, read-only. Asks Meta whether this published form can be
// sent from its number and why not: { check: { status, canSendMessage, entities, flowWabaId, formWabaId,
// numberInWaba } }. 409 when the form is not on Meta or its number is not connected; 502 when Meta refuses.
// Another account's id is a 404. Nothing is written locally or on Meta.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { checkFormOnMeta, formErrorResponse } from '@/lib/whatsapp/forms/service';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`forms:meta-check:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    return NextResponse.json({ check: await checkFormOnMeta(tenantOf(ctx), id) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return formErrorResponse(error);
  }
}
