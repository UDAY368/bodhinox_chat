// POST /s/<handle>/account/api/sign-in/verify  { challengeId, code }
// Checks a sign-in code (5 tries, works once) and signs the buyer in: 200
// { ok: true } with the account cookie (HttpOnly, SameSite=Lax, Path=/s/<handle>,
// 30 days). The token is only in the cookie, never in the body.

import { verifySignIn } from '@/lib/commerce/shop-customer';
import { CUSTOMER_COOKIE, customerCookieOptions } from '@/lib/commerce/shop-customer-cookie';
import { customerPost, type HandleParams } from '../../_lib/customer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: HandleParams) {
  const issued: { handle?: string; token?: string } = {};
  const response = await customerPost(request, context, 'verify', async (handle, body, _token, ip) => {
    const result = await verifySignIn(handle, { challengeId: body.challengeId, code: body.code, clientIp: ip });
    if (!result) return null;
    issued.handle = handle;
    issued.token = result.token;
    return { ok: true };
  });
  if (issued.handle && issued.token) response.cookies.set(CUSTOMER_COOKIE, issued.token, customerCookieOptions(issued.handle));
  return response;
}
