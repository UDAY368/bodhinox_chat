// POST /api/commerce/orders/counter { contact_id?, lines: [{ variant_id, qty }], method: 'cash'|'upi', reference?, note?, client_request_id }
//   Counter sale (admin and above with commerce.checkout and commerce.record_payments): a manual order priced on the
//   server, then the staff-recorded payment, as the same member. A price or total in the body is refused (400); no
//   contact_id means the workspace's walk-in customer.
//   201 { order, paid: true } | 200 for a replay; 202 { order, paid: false, payment_error } when the order exists but the
//   payment did not go through (repeat the same request to retry it). 404 contact_not_found; 409 store_not_configured,
//   a pricing refusal or out_of_stock. CSRF is enforced by the proxy.

import { NextResponse } from 'next/server';

import { createCounterSale, parseCounterSale } from '@/lib/commerce/counter-sale';
import { ManualOrderError } from '@/lib/commerce/manual-orders';
import { getOrder } from '@/lib/commerce/orders';
import { maskEmbeddedContact, resolvePhoneMask } from '@/lib/inbox/masking-apply';
import { jsonBody, lifecycleErrorResponse, NO_STORE, staffContext, writeLimit } from '../_lib/http';

export async function POST(request: Request) {
  try {
    const ctx = await staffContext('admin');
    const limited = writeLimit(ctx);
    if (limited) return limited;
    const input = parseCounterSale(await jsonBody(request));
    const sale = await createCounterSale(ctx, input);
    const order = await getOrder(ctx, sale.orderId);
    const mask = await resolvePhoneMask(ctx);
    const paid = sale.paymentError === null;
    return NextResponse.json(
      { order: mask ? maskEmbeddedContact(order, true) : order, paid, created: sale.created, ...(paid ? {} : { payment_error: sale.paymentError }) },
      { status: !paid ? 202 : sale.created ? 201 : 200, headers: NO_STORE });
  } catch (error) {
    if (error instanceof ManualOrderError)
      return NextResponse.json({ error: error.code, code: error.code, ...(error.variantId ? { variant_id: error.variantId } : {}) },
        { status: error.status, headers: NO_STORE });
    return lifecycleErrorResponse(error);
  }
}
