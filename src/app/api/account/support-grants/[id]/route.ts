// PATCH /api/account/support-grants/:id (owners and admins) -
//   { action: 'approve', minutes? } | { action: 'deny' } | { action: 'revoke' }.
//   approve: a waiting request (younger than 7 days) for the window asked, or a shorter one;
//   deny: a waiting request; revoke: an approved, unexpired grant. Audited as support.approved /
//   support.denied / support.revoked. 200 { grant }; 400 invalid; 404 not in this workspace;
//   409 not_pending / not_active / request_expired.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { decideSupportGrant, parseGrantDecision, supportErrorResponse } from '@/lib/platform/support';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`support-grants:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const decision = parseGrantDecision(await request.json().catch(() => null));
    if (!decision) return NextResponse.json({ error: 'invalid', code: 'invalid' }, { status: 400 });
    const { id } = await params;
    const grant = await withTenant(tenantOf(ctx), (tx) =>
      decideSupportGrant(tx, { accountId: ctx.accountId, userId: ctx.userId }, id, decision));
    return NextResponse.json({ grant }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return supportErrorResponse(error);
  }
}
