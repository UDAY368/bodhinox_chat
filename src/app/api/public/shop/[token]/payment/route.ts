// PUT /api/public/shop/<token>/payment  { expectedVersion, paymentMethod: 'online' | 'cod' }
// How this session's customer pays. 'cod' (cash on delivery) is refused with 409 cod_unavailable unless
// the store offers it and every product in the cart allows it; the quote then carries the COD fee. 'online' is
// refused with 409 online_unavailable while Razorpay is not connected. Answers the view without the catalogue.

import { loadStorefrontView, setPaymentMethodTx } from '@/lib/commerce/storefront';
import { mutateSession, type TokenParams } from '../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function PUT(request: Request, context: TokenParams) {
  return mutateSession(request, context, 'payment',
    (tx, ref, body, expectedVersion) => setPaymentMethodTx(tx, ref.accountId, ref.sessionId, { expectedVersion, paymentMethod: body.paymentMethod }),
    (tx, ref) => loadStorefrontView(tx, ref.accountId, ref.sessionId, undefined, { catalogue: false }));
}
