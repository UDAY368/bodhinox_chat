// POST /api/public/store/<handle>/delivery  { variantId, pincode, quantity? }
// "Check delivery" on a product page: answers { deliverable, shippingMinor, currency, cod } from this shop's own
// shipping rates. A bad pincode or an unknown variant is the plain 404 `not_found` answer (the same as an unknown shop).
// The pincode is not stored or logged.

import { checkDelivery } from '@/lib/commerce/pincode-check';
import { shopPost, type HandleParams } from '../../_lib/shop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request, context: HandleParams) {
  return shopPost(request, context, 'delivery', (handle, body) => checkDelivery(handle, body));
}
