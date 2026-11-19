// PUT /api/public/shop/<token>/delivery  { expectedVersion, deliveryMethod: 'ship' | 'pickup' | 'local' }
// How this session's order reaches the customer. 'pickup' and 'local' are refused with 409 delivery_unavailable unless
// the store offers them (and, for local delivery, the saved address is inside its postal prefixes). The fee is priced on
// the server by the quote, never taken from the browser. Answers the view without the catalogue.

import { loadStorefrontView, setDeliveryMethodTx } from '@/lib/commerce/storefront';
import { mutateSession, type TokenParams } from '../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function PUT(request: Request, context: TokenParams) {
  return mutateSession(request, context, 'delivery',
    (tx, ref, body, expectedVersion) => setDeliveryMethodTx(tx, ref.accountId, ref.sessionId, { expectedVersion, deliveryMethod: body.deliveryMethod }),
    (tx, ref) => loadStorefrontView(tx, ref.accountId, ref.sessionId, undefined, { catalogue: false }));
}
