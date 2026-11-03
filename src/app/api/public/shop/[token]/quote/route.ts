// POST /api/public/shop/<token>/quote  {}  the server price of the session now
// (lines, discount, shipping, tax, total) or a refusal code. Writes nothing.

import { assertOrigin } from '@/lib/auth/csrf';
import { isStorefrontTokenFormat } from '@/lib/commerce/storefront-token';
import { loadSession, quoteSessionTx } from '@/lib/commerce/storefront';
import { burstAllowed, enforceTokenLimit, inPublicTenant, json, notFound, publicError, resolveToken, tooMany, type TokenParams } from '../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: TokenParams) {
  try {
    assertOrigin(request);
    if (!burstAllowed('mutate', request)) return tooMany();
    const { token } = await params;
    if (!isStorefrontTokenFormat(token)) return notFound();
    const ref = await resolveToken(token, request);
    if (!ref) return notFound();
    await enforceTokenLimit(ref, 'mutate');
    const result = await inPublicTenant(ref.accountId, async (tx) => {
      const session = await loadSession(tx, ref.accountId, ref.sessionId);
      return session ? (await quoteSessionTx(tx, ref.accountId, session)).result : null;
    });
    if (!result) return notFound();
    return result.ok ? json({ quote: result.quote }) : json({ code: result.code }, 409);
  } catch (error) {
    return publicError(error, 'quote');
  }
}
