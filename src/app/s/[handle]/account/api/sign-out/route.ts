// POST /s/<handle>/account/api/sign-out  {}
// Revokes the session row and clears the account cookie. Always 200 for a public shop.

import { signOut } from '@/lib/commerce/shop-customer';
import { CUSTOMER_COOKIE, customerCookieOptions } from '@/lib/commerce/shop-customer-cookie';
import { isShopHandleFormat } from '@/lib/commerce/public-shop';
import { customerPost, type HandleParams } from '../_lib/customer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: HandleParams) {
  const response = await customerPost(request, context, 'sign_out', (handle, _body, token) => signOut(handle, token));
  const { handle } = await context.params;
  if (response.ok && isShopHandleFormat(handle)) response.cookies.set(CUSTOMER_COOKIE, '', customerCookieOptions(handle, 0));
  return response;
}
