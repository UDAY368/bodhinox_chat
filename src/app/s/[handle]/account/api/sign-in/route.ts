// POST /s/<handle>/account/api/sign-in  { phone: "+91…" }
// Sends a WhatsApp sign-in code (the shop's approved authentication template,
// the same limits per IP and per number as the cart's code). 200 { challengeId, expiresAt }.

import { startSignIn } from '@/lib/commerce/shop-customer';
import { customerPost, type HandleParams } from '../_lib/customer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request, context: HandleParams) {
  return customerPost(request, context, 'sign_in', (handle, body, _token, ip) => startSignIn(handle, { phone: body.phone, clientIp: ip }));
}
