// GET /api/commerce/orders?status=&source=&contact_id=&conversation_id=&q=&from=&to=&limit=&cursor=
//   Orders, newest first (agents and above; viewers get 403).
//   200 { orders: OrderListItem[], next_cursor: string | null }; 400 { error } for a bad filter.
// POST /api/commerce/orders { contact_id, lines: [{ variant_id, qty }], note?, client_request_id }
//   A manual order (agents and above with commerce.checkout). Every price comes from the catalogue on the
//   server; a price or total in the body is refused (400). 201 { order } (200 for a replay of the same
//   client_request_id). 404 contact_not_found; 409 store_not_configured, a pricing refusal (variant_unavailable,
//   price_not_configured, tax_not_configured, ...) or out_of_stock. CSRF is enforced by the proxy.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { createManualOrder, ManualOrderError, parseManualOrder } from '@/lib/commerce/manual-orders';
import { getOrder, listOrders, orderErrorResponse, parseOrderFilters } from '@/lib/commerce/orders';
import { maskEmbeddedContact, resolvePhoneMask } from '@/lib/inbox/masking-apply';
import { jsonBody, lifecycleErrorResponse, NO_STORE, staffContext, writeLimit } from './_lib/http';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const filters = parseOrderFilters(new URL(request.url).searchParams);
    const page = await listOrders(tenantOf(ctx), filters);
    const mask = await resolvePhoneMask(tenantOf(ctx));
    return NextResponse.json(mask ? { ...page, orders: page.orders.map((o) => maskEmbeddedContact(o, true)) } : page);
  } catch (error) {
    return orderErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await staffContext('agent');
    const limited = writeLimit(ctx);
    if (limited) return limited;
    const input = parseManualOrder(await jsonBody(request));
    const { orderId, created } = await createManualOrder(ctx, input);
    const order = await getOrder(ctx, orderId);
    const mask = await resolvePhoneMask(ctx);
    return NextResponse.json({ order: mask ? maskEmbeddedContact(order, true) : order, created },
      { status: created ? 201 : 200, headers: NO_STORE });
  } catch (error) {
    if (error instanceof ManualOrderError)
      return NextResponse.json({ error: error.code, code: error.code, ...(error.variantId ? { variant_id: error.variantId } : {}) },
        { status: error.status, headers: NO_STORE });
    return lifecycleErrorResponse(error);
  }
}
