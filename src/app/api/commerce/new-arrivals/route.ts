// POST /api/commerce/new-arrivals
//   { name, templateId, productIds[1..10], audience, bodyValues?, scheduledAt?, whatsappConfigId? }
//   Start a campaign from an approved carousel template whose cards are filled from the chosen
//   published products. Same rule as POST /api/broadcasts/create (agent role + campaigns.send);
//   the campaign itself is made by the same createCampaign.
//   202 { id }; 400/403/404 { error }

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { createNewArrivalsCampaign } from '@/lib/commerce/new-arrivals';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    await requirePermission(tenantOf(ctx), 'campaigns.send');
    const limit = await checkRateLimit(`commerce:new-arrivals:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    if (!request.headers.get('content-type')?.includes('application/json')) return NextResponse.json({ error: 'JSON content required' }, { status: 400 });
    const body: unknown = await request.json().catch(() => null);
    const result = await createNewArrivalsCampaign(tenantOf(ctx), body);
    return NextResponse.json(result, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
