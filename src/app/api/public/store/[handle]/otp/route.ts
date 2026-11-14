// POST /api/public/store/<handle>/otp  { phone: "+91…", cart: [{ variantId, qty }] }
// Sends a WhatsApp one-time code (the shop's approved authentication
// template) for this cart. 200 { challengeId, expiresAt }. Durable limits per
// IP and per number; the code itself is never stored or logged.

import { startOtp } from '@/lib/commerce/public-shop';
import { shopPost, type HandleParams } from '../../_lib/shop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request, context: HandleParams) {
  return shopPost(request, context, 'otp', (handle, body, ip) => startOtp(handle, { phone: body.phone, cart: body.cart, clientIp: ip }));
}
