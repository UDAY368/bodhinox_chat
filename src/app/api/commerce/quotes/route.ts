// GET  /api/commerce/quotes — the 50 newest quotes of the workspace (agents and above). 200 { quotes }.
// POST /api/commerce/quotes { contact_id, lines: [{ variant_id, qty }], note?, expires_in_hours?, client_request_id }
//   Pre-fill a shop cart for the customer and send its link into their WhatsApp chat with the storefront link sender
//   (permission commerce.checkout, agents and above). Prices are never read from the body and never locked: the
//   shop prices the cart again when the customer checks out. 201 { quote: { id, expires_at } }.
//   409 { code } for a refusal (checkout_disabled, outside_window, variant_unavailable, ...); nothing was sent.
// The link is never returned to the browser or logged: only the customer receives it. Revoke with
// DELETE /api/commerce/storefront-links/[id]. CSRF is enforced by the proxy.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { createQuote, listQuotes, parseQuoteInput } from '@/lib/commerce/quotes';
import { StoreError, storeErrorResponse } from '@/lib/commerce/store-settings';
import { UncertainDispatchError } from '@/lib/jobs/dispatch';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    return NextResponse.json({ quotes: await listQuotes(tenantOf(ctx)) }, { headers: NO_STORE });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const limit = await checkRateLimit(`commerce:quote:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseQuoteInput(await request.json().catch(() => null));
    const quote = await createQuote({ ...tenantOf(ctx), userId: ctx.userId }, input);
    return NextResponse.json({ quote: { id: quote.sessionId, expires_at: quote.expiresAt } }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof UncertainDispatchError) return storeErrorResponse(new StoreError('send_uncertain'));
    if (error instanceof MetaApiError) return storeErrorResponse(new StoreError('send_failed'));
    return storeErrorResponse(error);
  }
}
