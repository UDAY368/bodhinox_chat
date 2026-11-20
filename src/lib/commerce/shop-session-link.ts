/**
 * The buyer's link back into a storefront session that the server sends or hands out later: the abandoned-cart
 * reminder and the payment return (Razorpay's callback_url). Store Batch 6.
 *
 * The public shop's own themed pages (/s/<handle>/checkout/<token>, and its /done page) when the session is a plain
 * shop session (purpose 'shop', not a staff link or quote) and the workspace's shop is published and open to everyone.
 * Otherwise the plain /shop/<token> pages: a password or coming-soon shop would show its lock screen to the buyer's
 * cookieless WhatsApp browser, and order or status sessions belong to the staff flows. The token is the same either way.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { deriveStorefrontToken, shopCheckoutUrl, storefrontUrl } from './storefront-token';

export interface LinkedSession { id: string; token_epoch: number; purpose: string; is_quote: boolean; created_by: string | null }

/** The themed shop's handle when this session's links may open inside it, else null. */
export async function themedShopHandleTx(tx: TenantTransaction, accountId: string, session: LinkedSession): Promise<string | null> {
  if (session.purpose !== 'shop' || session.is_quote || session.created_by !== null) return null;
  const [row] = await tx.$queryRaw<{ handle: string }[]>`SELECT handle FROM shop_storefronts
    WHERE account_id=${accountId}::uuid AND published AND access_mode='open'`;
  return row?.handle ?? null;
}

/** The session's checkout link (`page` 'checkout') or its after-payment page (`page` 'done'). */
export async function sessionLinkTx(tx: TenantTransaction, accountId: string, session: LinkedSession, page: 'checkout' | 'done'): Promise<string> {
  const token = deriveStorefrontToken(session.id, session.token_epoch);
  const handle = await themedShopHandleTx(tx, accountId, session);
  const base = handle ? shopCheckoutUrl(handle, token) : storefrontUrl(token);
  return page === 'done' ? `${base}/done` : base;
}
