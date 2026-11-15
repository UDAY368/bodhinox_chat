// POST /s/<handle>/account/api/reorder  { orderId }
// The lines of one of the buyer's own orders that are on sale now, for the
// browser cart: 200 { lines: [{ variantId, qty }], skipped }. Prices are worked
// out by the server when the cart opens, as always.

import { reorderLinesTx, withCustomer } from '@/lib/commerce/shop-customer';
import { customerPost, type HandleParams } from '../_lib/customer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request, context: HandleParams) {
  return customerPost(request, context, 'reorder', (handle, body, token) =>
    withCustomer(handle, token, (tx, customer) => reorderLinesTx(tx, customer, body.orderId), { mutate: true }));
}
