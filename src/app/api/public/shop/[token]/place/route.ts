// POST /api/public/shop/<token>/place  { clientRequestId, expectedVersion, expectedTotalMinor, expectedPayableMinor?, marketingOptIn?, email?, emailOffers?, buyerGstin?, buyerLegalName? }
// Places the session's order (design E6): reprices, checks the total the
// customer saw, reserves stock and queues the payment link. A replay returns
// the same order. No money is assumed paid here; only an order that the customer's store credit and
// points (the server's own ledgers) pay in full is confirmed at once.

import { assertOrigin } from '@/lib/auth/csrf';
import { placeOrder } from '@/lib/commerce/checkout';
import { isStorefrontTokenFormat } from '@/lib/commerce/storefront-token';
import { loadStorefrontView } from '@/lib/commerce/storefront';
import { isUuid } from '@/lib/commerce/store-settings';
import {
  burstAllowed, enforceTokenLimit, inPublicTenant, json, notFound, publicError, readBody, resolveToken, tooMany, versionOf, type TokenParams,
} from '../../_lib/public';
import { revalidateShop } from '@/lib/commerce/shop-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: TokenParams) {
  try {
    assertOrigin(request);
    if (!(await burstAllowed('mutate', request))) return tooMany();
    const { token } = await params;
    if (!isStorefrontTokenFormat(token)) return notFound();
    const body = await readBody(request);
    const expectedVersion = versionOf(body);
    const total = body?.expectedTotalMinor;
    const optIn = body?.marketingOptIn;
    const email = body?.email, offers = body?.emailOffers;
    // What the customer saw as left to pay after store credit and points (absent: none were applied).
    const payable = body?.expectedPayableMinor;
    if (!body || expectedVersion === null || !isUuid(body.clientRequestId) || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0
      || (optIn !== undefined && typeof optIn !== 'boolean')
      || (body.buyerGstin !== undefined && typeof body.buyerGstin !== 'string') || (body.buyerLegalName !== undefined && typeof body.buyerLegalName !== 'string')
      || (email !== undefined && email !== null && (typeof email !== 'string' || email.length > 254))
      || (offers !== undefined && typeof offers !== 'boolean')
      || (payable !== undefined && (typeof payable !== 'number' || !Number.isSafeInteger(payable) || payable < 0)))
      return json({ code: 'invalid' }, 400);
    const ref = await resolveToken(token, request);
    if (!ref) return notFound();
    await enforceTokenLimit(ref, 'place');
    // placeOrder runs its own worker transaction and repeats the feature and suspension checks.
    const placed = await placeOrder(ref.accountId, ref.sessionId, {
      expectedVersion, expectedTotalMinor: total, clientRequestId: body.clientRequestId,
      ...(typeof payable === 'number' ? { expectedPayableMinor: payable } : {}),
      // Repeat-purchase consent (D13): only an explicit tick counts.
      ...(optIn === undefined ? {} : { marketingOptIn: optIn }),
      // Business buyer (optional): the server validates the GSTIN; an invalid one is a 400.
      buyerGstin: body.buyerGstin, buyerLegalName: body.buyerLegalName,
      // An optional email; "Email me offers" counts only when ticked.
      ...(typeof email === 'string' ? { email } : {}), ...(offers === undefined ? {} : { emailOffers: offers }),
    });
    if (placed.created) revalidateShop(ref.accountId); // stock went down
    const view = await inPublicTenant(ref.accountId, (tx) => loadStorefrontView(tx, ref.accountId, ref.sessionId));
    return json({ created: placed.created, view }, placed.created ? 201 : 200);
  } catch (error) {
    return publicError(error, 'place');
  }
}
