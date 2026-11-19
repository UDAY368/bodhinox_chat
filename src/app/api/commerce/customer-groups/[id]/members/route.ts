// POST   /api/commerce/customer-groups/<id>/members { contact_id } — put a contact into the group (admins only).
// DELETE /api/commerce/customer-groups/<id>/members { contact_id } — take it out (admins only).
// 200 { customer_group }; 404 not_found; 400 invalid (a contact of another workspace). Membership grants wholesale
// prices, so agents cannot change it: the role is checked here and again by RLS on the table.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { setGroupMember } from '@/lib/commerce/price-rules-store';
import { storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

async function change(request: Request, { params }: Params, member: boolean) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:customer-groups:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as { contact_id?: unknown } | null;
    return NextResponse.json({ customer_group: await setGroupMember({ ...tenantOf(ctx), userId: ctx.userId }, id, body?.contact_id, member) });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export const POST = (request: Request, context: Params) => change(request, context, true);
export const DELETE = (request: Request, context: Params) => change(request, context, false);
