// POST /api/public/store/<handle>/unlock  { password }
// The visitor's password for a password-protected shop. 200 { ok: true } and a signed httpOnly cookie
// named for this shop; 403 { code: 'wrong_password' }; 429 too many attempts; 404 when the shop is not in
// password mode (or does not exist). Origin, size and burst checks come from shopPost; attempts are limited
// per client address and per shop (shop-access.ts).

import { resolvePublicShop } from '@/lib/commerce/public-shop';
import { unlockShop } from '@/lib/commerce/shop-access';
import { shopPost, ShopReply, type HandleParams } from '../../_lib/shop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request, context: HandleParams) {
  return shopPost(request, context, 'unlock', async (handle, body, ip) => {
    const accountId = await resolvePublicShop(handle);
    if (!accountId) return null;
    const reply = await unlockShop(accountId, handle, body.password, ip);
    return reply ? new ShopReply(reply.body, reply.cookie) : null;
  });
}
