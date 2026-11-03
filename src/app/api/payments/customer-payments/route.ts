// GET /api/payments/customer-payments — money customers paid this workspace
// (gateway and staff-recorded), newest first. Agent and above.
//     ?order_id=&appointment_id=&settlement=&before=<ISO>&limit=
// Ids, amounts, statuses and codes only: never customer or provider text.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { listCustomerPayments } from '@/lib/payments/queries';

const t = getT('Validation.payments');
const headers = { 'Cache-Control': 'private, no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SETTLEMENTS = ['pending', 'settled', 'exception', 'unattached'];

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const params = new URL(request.url).searchParams;
    const orderId = params.get('order_id') || undefined;
    const appointmentId = params.get('appointment_id') || undefined;
    const settlement = params.get('settlement') || undefined;
    const beforeRaw = params.get('before');
    const before = beforeRaw ? new Date(beforeRaw) : undefined;
    if ((orderId && !UUID.test(orderId)) || (appointmentId && !UUID.test(appointmentId)) || (settlement && !SETTLEMENTS.includes(settlement))
      || (before && Number.isNaN(before.getTime()))) return NextResponse.json({ error: t('invalidFilter') }, { status: 400 });
    const limit = Number(params.get('limit') ?? 50);
    const payments = await withTenant(tenantOf(ctx), (tx) => listCustomerPayments(tx, ctx.accountId, {
      orderId, appointmentId, settlement, before, limit: Number.isFinite(limit) ? limit : 50,
    }));
    return NextResponse.json({ payments }, { headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}
