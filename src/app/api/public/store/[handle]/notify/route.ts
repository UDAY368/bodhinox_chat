// POST /api/public/store/<handle>/notify  { variantId }
// "Notify me on WhatsApp" for a sold-out variant: saves a code (48 hours) and answers { code, whatsappUrl },
// a wa.me link whose message ends with "NOTIFY <CODE>". The buyer's own message claims it (handleStockAlertCode);
// nothing is sent before that.

import { createStockAlert } from '@/lib/commerce/public-shop';
import { shopPost, type HandleParams } from '../../_lib/shop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request, context: HandleParams) {
  return shopPost(request, context, 'notify', (handle, body, ip) => createStockAlert(handle, { variantId: body.variantId, clientIp: ip }));
}
