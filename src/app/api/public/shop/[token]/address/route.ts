// PUT /api/public/shop/<token>/address  { expectedVersion, address | null }
// The delivery address for this session only (no saved addresses, design E12).

import { loadStorefrontView, setAddressTx } from '@/lib/commerce/storefront';
import { mutateSession, type TokenParams } from '../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function PUT(request: Request, context: TokenParams) {
  return mutateSession(request, context, 'address',
    (tx, ref, body, expectedVersion) => setAddressTx(tx, ref.accountId, ref.sessionId, { expectedVersion, address: body.address ?? null }),
    (tx, ref) => loadStorefrontView(tx, ref.accountId, ref.sessionId));
}
