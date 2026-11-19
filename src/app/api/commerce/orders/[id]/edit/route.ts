// Edit an order before dispatch (Store Phase 5). Agents and above with commerce.checkout; an edit that refunds
// money also needs commerce.refunds (admin ceiling). Another workspace's order is a 404.
//   GET  -> 200 { edit: { version, blocked, currency, lines: [{ id, variant_id, name, sku, quantity, shipped,
//           unit_price_minor }], balance_due_minor, edits: [...] } }
//   POST { expected_version, lines: [{ variant_id, qty }], reason, client_request_id, refunded_outside?, preview? }
//        The lines are the full new set; prices are never accepted, the server reprices.
//        preview: true -> 200 { preview: { version, currency, before, after, lines, payment: { action,
//           difference_minor, needs_outside_confirmation } } } and nothing is saved.
//        otherwise -> 200 { edit_id, created, payment_action } (created false for a replayed client_request_id).
//        400 invalid; 409 { code } conflict (stale expected_version) | not_editable | no_change | below_shipped |
//        out_of_stock | payment_link_open | refund_in_flight | invoice_issued | offline_payment | cod_shipment_live |
//        a pricing refusal; 403 without the permission.
// CSRF: session mutations pass the proxy's assertMutation.

import { NextResponse } from 'next/server';

import { editOrder, getOrderEditState, OrderEditError, parseOrderEdit, previewOrderEdit } from '@/lib/commerce/order-edits';
import { jsonBody, lifecycleErrorResponse, NO_STORE, staffContext, writeLimit } from '../../_lib/http';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

function errorResponse(error: unknown): NextResponse {
  if (error instanceof OrderEditError)
    return NextResponse.json({ error: 'Order edit refused', code: error.code, ...(error.variantId ? { variant_id: error.variantId } : {}) },
      { status: error.status, headers: NO_STORE });
  return lifecycleErrorResponse(error);
}

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await staffContext();
    return NextResponse.json({ edit: await getOrderEditState(ctx, id) }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await staffContext();
    const limited = writeLimit(ctx);
    if (limited) return limited;
    const body = await jsonBody(request);
    const input = parseOrderEdit(body);
    if (body.preview === true) return NextResponse.json({ preview: await previewOrderEdit(ctx, id, input) }, { headers: NO_STORE });
    const result = await editOrder(ctx, id, input);
    return NextResponse.json({ edit_id: result.editId, created: result.created, payment_action: result.payment_action }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
