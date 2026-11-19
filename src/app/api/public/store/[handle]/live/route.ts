// POST /api/public/store/<handle>/live  { path }
// The shop's page-view beacon (store plan Phase 8, batch 7): adds 1 to a per-minute counter for a fixed page key. Nothing about the
// visitor is read or stored. Same Origin, size and burst checks as every public POST; a shop that is not open answers the plain 404.

import { recordShopHit } from '@/lib/commerce/shop-live';
import { shopPost, type HandleParams } from '../../_lib/shop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request, context: HandleParams) {
  return shopPost(request, context, 'live', async (handle, body) => ((await recordShopHit(handle, body.path)) ? {} : null));
}
