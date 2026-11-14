// POST /api/public/store/<handle>/otp/verify  { challengeId, code }
// Checks the code (5 tries), finds or creates the buyer's contact and opens
// checkout: 200 { url } of an ordinary private storefront session holding
// the cart. A repeat of a verified challenge answers the same link.

import { verifyOtp } from '@/lib/commerce/public-shop';
import { shopPost, type HandleParams } from '../../../_lib/shop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request, context: HandleParams) {
  return shopPost(request, context, 'otp_verify', (handle, body, ip) =>
    verifyOtp(handle, { challengeId: body.challengeId, code: body.code, clientIp: ip }));
}
