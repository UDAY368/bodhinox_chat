// POST /s/<handle>/account/api/checkout  { cart: [{ variantId, qty }], addressId? }
// "Check out as <my number>": opens the ordinary private checkout for the
// signed-in buyer with this cart, without a new code. 200 { url }.

import { checkoutAsCustomer } from '@/lib/commerce/shop-customer';
import { customerPost, type HandleParams } from '../_lib/customer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request, context: HandleParams) {
  return customerPost(request, context, 'checkout', (handle, body, token) =>
    checkoutAsCustomer(handle, token, { cart: body.cart, addressId: body.addressId }));
}
