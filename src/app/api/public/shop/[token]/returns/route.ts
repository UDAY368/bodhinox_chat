// POST /api/public/shop/<token>/returns
//   { clientRequestId, reason, note?, lines: [{ order_item_id, qty, exchange_variant_id? }] }
// A buyer's return or exchange request from the order page. The order is the session's own; the shop must offer requests and
// the return window must be open. Staff approve or reject it in the returns flow; nothing is refunded or restocked here.
// 200 { created, order } (a replay of the same clientRequestId answers created: false); 409 returns_unavailable |
// return_window_closed | return_line_open | return_quantity | exchange_unavailable; 400 invalid. No photo upload: there is no
// safe upload path for an anonymous buyer yet.

import { requestBuyerReturnTx } from '@/lib/commerce/buyer-returns';
import { loadOrderView, loadSession } from '@/lib/commerce/storefront';
import { sessionAction, type TokenParams } from '../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request, context: TokenParams) {
  return sessionAction(request, context, 'returns', async (tx, ref, body) => {
    const { created } = await requestBuyerReturnTx(tx, ref.accountId, ref.sessionId, body);
    const session = await loadSession(tx, ref.accountId, ref.sessionId);
    return { created, order: session?.order_id ? await loadOrderView(tx, ref.accountId, session.order_id) : null };
  });
}
