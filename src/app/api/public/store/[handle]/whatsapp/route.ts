// POST /api/public/store/<handle>/whatsapp  { cart: [{ variantId, qty }] }
// "Order on WhatsApp": saves the cart under a six-character code (48 hours)
// and answers { code, whatsappUrl }, a wa.me link whose message ends with
// "ORDER <CODE>". The buyer's message claims it (handleShopCartCode).

import { createCartCode } from '@/lib/commerce/public-shop';
import { shopPost, type HandleParams } from '../../_lib/shop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request, context: HandleParams) {
  return shopPost(request, context, 'whatsapp', (handle, body, ip) => createCartCode(handle, { cart: body.cart, clientIp: ip }));
}
