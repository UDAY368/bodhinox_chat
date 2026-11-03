// POST /api/commerce/payment-exceptions/{id}/resolve — { resolution } (admin).
// A held payment closes only once it is fully refunded ('refunded'), or, for a
// late payment that found no stock, by taking the stock back and accepting it
// ('restocked'); other kinds are 'dismissed' once handled. Audited.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getT } from '@/lib/i18n/translate';
import { RESOLUTIONS, resolvePaymentException, type Resolution } from '@/lib/payments/exceptions';
import { paymentsErrorResponse, readJsonObject } from '@/lib/payments/http';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const t = getT('Validation.payments');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIMIT = { limit: 30, windowMs: 60_000 };

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await context.params;
    const limit = checkRateLimit(`paymentException:${ctx.userId}`, LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const body = await readJsonObject(request);
    if (!body || !(RESOLUTIONS as readonly unknown[]).includes(body.resolution)) return NextResponse.json({ error: t('invalidRequest'), code: 'resolution' }, { status: 400 });
    if (!UUID.test(id)) return NextResponse.json({ error: t('not_found'), code: 'not_found' }, { status: 404 });
    await resolvePaymentException({ ...tenantOf(ctx), userId: ctx.userId }, id, body.resolution as Resolution);
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return paymentsErrorResponse(error);
  }
}
