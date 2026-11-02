// POST /api/commerce/catalogs/[id]/sync — queue a product sync now (admin, rate limited).
//   202 { queued: true }; 404. The job is stored before this answers; the catalogue's
//   last_synced_at and sync_error show the result. Repeated clicks within a minute queue one sync.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { requestCatalogSync } from '@/lib/commerce/catalog';
import { catalogErrorResponse } from '@/lib/commerce/catalog-http';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`catalogs:sync:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    await requestCatalogSync(tenantOf(ctx), id);
    return NextResponse.json({ queued: true }, { status: 202 });
  } catch (error) {
    return catalogErrorResponse(error);
  }
}
