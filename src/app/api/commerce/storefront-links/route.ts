// POST /api/commerce/storefront-links — issue a storefront link for a
// conversation's contact and send it from the conversation's number
// (permission commerce.checkout, agent and above).
//   body { conversation_id, purpose: 'shop' | 'status', ttl_hours?, message?, client_request_id }
//   201 { session: { sessionId, expiresAt, purpose, orderId } }
//   409 { code } for a refusal (checkout_disabled, no_order, outside_window, ...); nothing was sent.
// The link itself is never returned to the browser or logged: only the customer receives it.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { parseStaffLinkInput, sendStaffStorefrontLink } from '@/lib/commerce/storefront';
import { StoreError, storeErrorResponse } from '@/lib/commerce/store-settings';
import { UncertainDispatchError } from '@/lib/jobs/dispatch';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`commerce:storefront-link:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseStaffLinkInput(await request.json().catch(() => null));
    const { session } = await sendStaffStorefrontLink({ ...tenantOf(ctx), userId: ctx.userId }, input);
    return NextResponse.json({
      session: { sessionId: session.sessionId, expiresAt: session.expiresAt, purpose: session.purpose, orderId: session.orderId },
    }, { status: 201 });
  } catch (error) {
    if (error instanceof UncertainDispatchError) return storeErrorResponse(new StoreError('send_uncertain'));
    if (error instanceof MetaApiError) return storeErrorResponse(new StoreError('send_failed'));
    return storeErrorResponse(error);
  }
}
