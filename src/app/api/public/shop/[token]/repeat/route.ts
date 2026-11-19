// PUT /api/public/shop/<token>/repeat  { expectedVersion }
// One-tap checkout for a repeat buyer (contact-based): copies the address and delivery choice of this session's own
// contact's last order onto the cart. 409 repeat_unavailable when there is none. The full address is never sent to the
// browser; the view shows only name, town and postcode (StorefrontView.repeat). Answers the view without the catalogue.

import { applyRepeatTx, loadStorefrontView } from '@/lib/commerce/storefront';
import { mutateSession, type TokenParams } from '../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function PUT(request: Request, context: TokenParams) {
  return mutateSession(request, context, 'repeat',
    (tx, ref, _body, expectedVersion) => applyRepeatTx(tx, ref.accountId, ref.sessionId, { expectedVersion }),
    (tx, ref) => loadStorefrontView(tx, ref.accountId, ref.sessionId, undefined, { catalogue: false }));
}
