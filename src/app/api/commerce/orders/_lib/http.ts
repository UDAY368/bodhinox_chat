// Shared helpers for the order lifecycle routes (dispatch, deliver, feedback,
// cancel-refund, events, returns, documents). Every route: requireRole, a
// per-member write limit, CSRF by the proxy (assertMutation), ids and codes
// only in responses and logs.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import type { AccountRole } from '@/lib/auth/roles';
import { tenantOf } from '@/lib/audience/http';
import { orderErrorResponse } from '@/lib/commerce/orders';
import { StockError } from '@/lib/commerce/stock';
import type { StaffContext } from '@/lib/commerce/order-lifecycle';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const NO_STORE = { 'Cache-Control': 'private, no-store' };

/** The signed-in member, at least `minimum`, as a staff context. */
export async function staffContext(minimum: AccountRole = 'agent'): Promise<StaffContext> {
  const ctx = await requireRole(minimum);
  return { ...tenantOf(ctx), userId: ctx.userId };
}

/** null when the member may write, else the 429 response. */
export function writeLimit(ctx: StaffContext): NextResponse | null {
  const limit = checkRateLimit(`orders:write:${ctx.userId}`, RATE_LIMITS.send);
  return limit.success ? null : (rateLimitResponse(limit) as NextResponse);
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text().catch(() => '');
  if (text.length > 16_384) return {};
  try {
    const body = text ? JSON.parse(text) : {};
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch {
    return {};
  }
}

/**
 * OrderError and auth errors as usual; a stock refusal is a 409 with its
 * code; a payments error that carries its own 4xx status and code (refunds)
 * is passed through; anything else is a 500 with no detail.
 */
export function lifecycleErrorResponse(error: unknown): NextResponse {
  if (error instanceof StockError) return NextResponse.json({ error: 'Stock changed', code: error.code }, { status: 409 });
  const e = error as { status?: unknown; code?: unknown; name?: unknown } | null;
  if (e && typeof e.status === 'number' && e.status >= 400 && e.status < 500 && typeof e.code === 'string'
    && typeof e.name === 'string' && /Refund|Payment/.test(e.name))
    return NextResponse.json({ error: 'Refund refused', code: e.code }, { status: e.status });
  return orderErrorResponse(error);
}
