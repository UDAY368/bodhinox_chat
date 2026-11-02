// POST /api/commerce/events/{id}/resolve { resolution: 'sent' | 'not_sent' } (admins and owners)
//   Records what the admin found after checking the chat for a failed or
//   unknown-outcome send. Never sends or re-sends anything.
//   200 { event }; 400 { code: 'resolution' }; 404 { code: 'not_found' } (also another
//   workspace's id); 409 { code: 'not_open' } when it is not waiting on an admin.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { AttentionError, parseResolution, resolveCommerceEvent } from '@/lib/commerce/event-attention';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const t = getT('Validation.commerceEvents');
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerceEvents:resolve:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);
    const resolution = parseResolution(await request.json().catch(() => null));
    if (!resolution) return NextResponse.json({ error: t('resolution'), code: 'resolution' }, { status: 400 });
    return NextResponse.json({ event: await resolveCommerceEvent(tenantOf(ctx), id, resolution) });
  } catch (error) {
    if (error instanceof AttentionError) return NextResponse.json({ error: t(error.code), code: error.code }, { status: error.status });
    return toErrorResponse(error);
  }
}
