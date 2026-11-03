// GET /api/commerce/payment-exceptions — payments that did not settle silently
// (late, closed order, duplicate, mismatch, merchant changed, unmatched) and
// refunds that need a person. Admin and above. ?status=open|resolved&order_id=&before=&limit=

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { listPaymentExceptions } from '@/lib/payments/exceptions';

const t = getT('Validation.payments');
const headers = { 'Cache-Control': 'private, no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const params = new URL(request.url).searchParams;
    const status = params.get('status') || undefined;
    const orderId = params.get('order_id') || undefined;
    const beforeRaw = params.get('before');
    const before = beforeRaw ? new Date(beforeRaw) : undefined;
    if ((status && status !== 'open' && status !== 'resolved') || (orderId && !UUID.test(orderId)) || (before && Number.isNaN(before.getTime())))
      return NextResponse.json({ error: t('invalidFilter') }, { status: 400 });
    const limit = Number(params.get('limit') ?? 50);
    const exceptions = await withTenant(tenantOf(ctx), (tx) => listPaymentExceptions(tx, ctx.accountId, {
      status: status as 'open' | 'resolved' | undefined, orderId, before, limit: Number.isFinite(limit) ? limit : 50,
    }));
    return NextResponse.json({ exceptions }, { headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}
