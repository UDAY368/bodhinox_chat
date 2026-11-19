// GET  /api/commerce/customer-balances?contact_id=<uuid> — the store credit and loyalty points of a contact, with the
//   latest ledger entries (agents and above). 404 contact_not_found.
// POST /api/commerce/customer-balances — adjust a balance (admins only), with a reason:
//   { contact_id, ledger: 'credit' | 'points', amount (signed: minor units or points), reason, client_request_id }
//   200 { balance, created }; 409 store_credit_insufficient / points_insufficient. A repeated request id changes nothing.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { adjustBalance, getContactBalances, parseAdjust } from '@/lib/commerce/store-credit';
import { storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const contactId = new URL(request.url).searchParams.get('contact_id') ?? '';
    return NextResponse.json({ balances: await getContactBalances(tenantOf(ctx), contactId) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:balances:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseAdjust(await request.json().catch(() => null));
    return NextResponse.json(await adjustBalance({ ...tenantOf(ctx), userId: ctx.userId }, input));
  } catch (error) {
    return storeErrorResponse(error);
  }
}
