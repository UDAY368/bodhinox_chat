// POST /api/public/shop/<token>/place  { clientRequestId, expectedVersion, expectedTotalMinor }
// Places the session's order (design E6): reprices, checks the total the
// customer saw, reserves stock and queues the payment link. A replay returns
// the same order. Nothing here can mark an order paid.

import { assertOrigin } from '@/lib/auth/csrf';
import { placeOrder } from '@/lib/commerce/checkout';
import { isStorefrontTokenFormat } from '@/lib/commerce/storefront-token';
import { loadStorefrontView } from '@/lib/commerce/storefront';
import { isUuid } from '@/lib/commerce/store-settings';
import {
  burstAllowed, enforceTokenLimit, inPublicTenant, json, notFound, publicError, readBody, resolveToken, tooMany, versionOf, type TokenParams,
} from '../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: TokenParams) {
  try {
    assertOrigin(request);
    if (!burstAllowed('mutate', request)) return tooMany();
    const { token } = await params;
    if (!isStorefrontTokenFormat(token)) return notFound();
    const body = await readBody(request);
    const expectedVersion = versionOf(body);
    const total = body?.expectedTotalMinor;
    if (!body || expectedVersion === null || !isUuid(body.clientRequestId) || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0)
      return json({ code: 'invalid' }, 400);
    const ref = await resolveToken(token, request);
    if (!ref) return notFound();
    await enforceTokenLimit(ref, 'place');
    // placeOrder runs its own worker transaction and repeats the feature and suspension checks.
    const placed = await placeOrder(ref.accountId, ref.sessionId, {
      expectedVersion, expectedTotalMinor: total, clientRequestId: body.clientRequestId,
    });
    const view = await inPublicTenant(ref.accountId, (tx) => loadStorefrontView(tx, ref.accountId, ref.sessionId));
    return json({ created: placed.created, view }, placed.created ? 201 : 200);
  } catch (error) {
    return publicError(error, 'place');
  }
}
