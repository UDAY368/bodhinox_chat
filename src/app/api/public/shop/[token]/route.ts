// GET /api/public/shop/<token>  the storefront view for one contact-bound session
// (published products, this session's cart, address, coupon and quote, and the
// one order it placed). Only sha256(token) reaches the database. Read-only.

import { isStorefrontTokenFormat } from '@/lib/commerce/storefront-token';
import { loadStorefrontView } from '@/lib/commerce/storefront';
import { burstAllowed, inPublicTenant, json, notFound, publicError, resolveToken, tooMany, type TokenParams } from '../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: TokenParams) {
  if (!burstAllowed('read', request)) return tooMany();
  try {
    const { token } = await params;
    if (!isStorefrontTokenFormat(token)) return notFound();
    const ref = await resolveToken(token, request);
    if (!ref) return notFound();
    const view = await inPublicTenant(ref.accountId, (tx) => loadStorefrontView(tx, ref.accountId, ref.sessionId));
    return view ? json(view) : notFound();
  } catch (error) {
    return publicError(error, 'view');
  }
}
