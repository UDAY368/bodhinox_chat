// DELETE /api/commerce/storefront-links/<id> — revoke a storefront link (permission
// commerce.checkout). The link stops working at once; a placed order is unaffected.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { revokeStorefrontSession } from '@/lib/commerce/storefront';
import { storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`commerce:storefront-link:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    await revokeStorefrontSession({ ...tenantOf(ctx), userId: ctx.userId }, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
