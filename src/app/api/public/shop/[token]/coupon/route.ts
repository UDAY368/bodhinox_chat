// PUT /api/public/shop/<token>/coupon  { expectedVersion, code | null }
// Applies or removes a coupon code; its validity shows in the quote.

import { applyCouponTx, loadStorefrontView } from '@/lib/commerce/storefront';
import { mutateSession, type TokenParams } from '../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function PUT(request: Request, context: TokenParams) {
  return mutateSession(request, context, 'coupon',
    (tx, ref, body, expectedVersion) => applyCouponTx(tx, ref.accountId, ref.sessionId, { expectedVersion, code: body.code ?? null }),
    (tx, ref) => loadStorefrontView(tx, ref.accountId, ref.sessionId));
}
