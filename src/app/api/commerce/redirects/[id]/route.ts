// DELETE /api/commerce/redirects/<id> — remove a redirect rule (admins). 200 { ok: true }; 404 not_found.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { removeRedirect } from '@/lib/commerce/shop-redirects';
import { isUuid, StoreError, storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin');
    const limit = await checkRateLimit(`commerce:redirects:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    if (!isUuid(id) || !(await removeRedirect({ ...tenantOf(ctx), userId: ctx.userId }, id))) throw new StoreError('not_found');
    return NextResponse.json({ ok: true });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
