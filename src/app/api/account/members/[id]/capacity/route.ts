// GET /api/account/members/:id/capacity (admins and owners) — the member's limit on
//   open conversations and how many they hold now:
//   200 { capacity: { user_id, max_open_conversations, open_conversations } }.
// PUT /api/account/members/:id/capacity (admins and owners) — { max_open_conversations:
//   1..1000 | null } (null: no limit). Automatic assignment (src/lib/inbox/routing.ts) skips a
//   member at their limit. 200 { capacity }; 400 invalid_capacity; 404 not a member of this
//   workspace (another workspace's member included).
// `:id` is the member's user id (the sibling members route uses the same segment name).
// CSRF/mutation origin is enforced by src/proxy.ts.
import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getMemberCapacity, parseCapacityInput, RoutingRuleError, setMemberCapacity } from '@/lib/inbox/routing';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };
const headers = { 'Cache-Control': 'private, no-store' };

function errorResponse(error: unknown) {
  if (error instanceof RoutingRuleError) return NextResponse.json({ error: error.code, code: error.code }, { status: error.status });
  return toErrorResponse(error);
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await requireRole('admin');
    return NextResponse.json({ capacity: await getMemberCapacity(tenantOf(ctx), id) }, { headers });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`admin:memberCapacity:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const max = parseCapacityInput(await request.json().catch(() => null));
    return NextResponse.json({ capacity: await setMemberCapacity(tenantOf(ctx), id, max) }, { headers });
  } catch (error) {
    return errorResponse(error);
  }
}
