// PUT /api/public/shop/<token>/extras  { expectedVersion, extras: { note?, gift_message?, delivery_date?, slot_id?, custom? } }
// What the buyer asks for at checkout: an order note, a gift message, a delivery date and time slot, and the shop's custom
// fields. Checked on the server against the shop's offer (fixed caps, date range from the lead days, slot and choice lists);
// 400 { code: 'extras_invalid', field } otherwise. Not part of pricing. Placing checks again and enforces the required fields.
// Answers the view without the catalogue.

import { loadStorefrontView, setExtrasTx } from '@/lib/commerce/storefront';
import { mutateSession, type TokenParams } from '../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function PUT(request: Request, context: TokenParams) {
  return mutateSession(request, context, 'extras',
    (tx, ref, body, expectedVersion) => setExtrasTx(tx, ref.accountId, ref.sessionId, { expectedVersion, extras: body.extras }),
    (tx, ref) => loadStorefrontView(tx, ref.accountId, ref.sessionId, undefined, { catalogue: false }));
}
