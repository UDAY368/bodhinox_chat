// GET  /api/public/shop/<token>/wishlist  the contact's saved variants. 200 { currency, items }.
// POST /api/public/shop/<token>/wishlist  { action: 'add' | 'remove', variantId } | { action: 'sync', variantIds }
//   'sync' saves a browser's own list once the visitor is identified by this session (off-sale variants are skipped).
//   Answers the list. At most 50 saved variants (409 wishlist_full); 409 variant_unavailable for an add of a variant not on sale.
// The contact is the one this session belongs to: nobody else's list is reachable. A price drop on a saved variant can send the
// contact one WhatsApp nudge, only when the shop turned that on and the contact has not opted out (price-drop-jobs.ts).

import { isStorefrontTokenFormat } from '@/lib/commerce/storefront-token';
import { loadSession } from '@/lib/commerce/storefront';
import { StoreError } from '@/lib/commerce/store-settings';
import { addToWishlistTx, listWishlistTx, parseVariantIds, removeFromWishlistTx } from '@/lib/commerce/wishlist';
import { burstAllowed, inPublicTenant, json, notFound, publicError, resolveToken, sessionAction, tooMany, type TokenParams } from '../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: TokenParams) {
  if (!(await burstAllowed('read', request))) return tooMany();
  try {
    const { token } = await params;
    if (!isStorefrontTokenFormat(token)) return notFound();
    const ref = await resolveToken(token, request);
    if (!ref) return notFound();
    const list = await inPublicTenant(ref.accountId, async (tx) => {
      const session = await loadSession(tx, ref.accountId, ref.sessionId);
      return session ? listWishlistTx(tx, ref.accountId, session.contact_id) : null;
    });
    return list ? json(list) : notFound();
  } catch (error) {
    return publicError(error, 'wishlist');
  }
}

export function POST(request: Request, context: TokenParams) {
  return sessionAction(request, context, 'wishlist', async (tx, ref, body) => {
    const session = await loadSession(tx, ref.accountId, ref.sessionId);
    if (!session) return null;
    const contactId = session.contact_id;
    if (body.action === 'add') {
      const added = parseVariantIds([body.variantId]);
      if (!added.length) throw new StoreError('invalid', { field: 'variantId' });
      await addToWishlistTx(tx, ref.accountId, contactId, added);
    }
    else if (body.action === 'remove') await removeFromWishlistTx(tx, ref.accountId, contactId, String(body.variantId));
    else if (body.action === 'sync') await addToWishlistTx(tx, ref.accountId, contactId, parseVariantIds(body.variantIds), { lenient: true });
    else throw new StoreError('invalid', { field: 'action' });
    return listWishlistTx(tx, ref.accountId, contactId);
  });
}
