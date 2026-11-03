// PUT /api/public/shop/<token>/cart  { expectedVersion, lines: [{ variantId, qty }] }
// Replaces the session's cart (shop links only). Every variant is re-checked
// in the tenant against published, non-archived, priced rows.

import { loadStorefrontView, updateCartTx } from '@/lib/commerce/storefront';
import { mutateSession, type TokenParams } from '../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function PUT(request: Request, context: TokenParams) {
  return mutateSession(request, context, 'cart',
    (tx, ref, body, expectedVersion) => updateCartTx(tx, ref.accountId, ref.sessionId, { expectedVersion, lines: body.lines }),
    (tx, ref) => loadStorefrontView(tx, ref.accountId, ref.sessionId));
}
