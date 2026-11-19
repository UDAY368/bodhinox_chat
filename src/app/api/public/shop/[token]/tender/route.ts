// PUT /api/public/shop/<token>/tender  { expectedVersion, useStoreCredit: boolean, usePoints: boolean }
// Whether the customer of this session pays with their store credit and their loyalty points. Both are plain
// switches: the quote spends what the balances and the rules of the store allow, never an amount from the
// browser. Answers the view without the catalogue.

import { loadStorefrontView, setTenderTx } from '@/lib/commerce/storefront';
import { mutateSession, type TokenParams } from '../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function PUT(request: Request, context: TokenParams) {
  return mutateSession(request, context, 'tender',
    (tx, ref, body, expectedVersion) => setTenderTx(tx, ref.accountId, ref.sessionId,
      { expectedVersion, useStoreCredit: body.useStoreCredit, usePoints: body.usePoints }),
    (tx, ref) => loadStorefrontView(tx, ref.accountId, ref.sessionId, undefined, { catalogue: false }));
}
