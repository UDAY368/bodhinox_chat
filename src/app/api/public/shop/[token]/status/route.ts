// GET /api/public/shop/<token>/status  the session's order status, read from the
// database only (design E13): the success page polls this and ignores every
// razorpay_* query parameter, so a redirect can never mark an order paid.

import { isStorefrontTokenFormat } from '@/lib/commerce/storefront-token';
import { loadOrderView, loadSession } from '@/lib/commerce/storefront';
import { burstAllowed, inPublicTenant, json, notFound, publicError, resolveToken, tooMany, type TokenParams } from '../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: TokenParams) {
  if (!burstAllowed('read', request)) return tooMany();
  try {
    const { token } = await params;
    if (!isStorefrontTokenFormat(token)) return notFound();
    const ref = await resolveToken(token, request);
    if (!ref) return notFound();
    const order = await inPublicTenant(ref.accountId, async (tx) => {
      const session = await loadSession(tx, ref.accountId, ref.sessionId);
      return session?.order_id ? loadOrderView(tx, ref.accountId, session.order_id) : null;
    });
    return json({ order });
  } catch (error) {
    return publicError(error, 'status');
  }
}
