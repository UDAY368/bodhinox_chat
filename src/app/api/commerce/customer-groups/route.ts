// GET  /api/commerce/customer-groups — the customer groups of the workspace with their members (agents and above).
// POST /api/commerce/customer-groups — create one (admins): { name }. 201 { customer_group }; 409 price_rule_limit (20 groups).
// A group decides who gets a wholesale price list or a group discount rule, so only admins change it.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { createCustomerGroup, listCustomerGroups, parseCustomerGroup } from '@/lib/commerce/price-rules-store';
import { storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    return NextResponse.json({ customer_groups: await listCustomerGroups(tenantOf(ctx)) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:customer-groups:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseCustomerGroup(await request.json().catch(() => null));
    return NextResponse.json({ customer_group: await createCustomerGroup({ ...tenantOf(ctx), userId: ctx.userId }, input) }, { status: 201 });
  } catch (error) {
    return storeErrorResponse(error);
  }
}
