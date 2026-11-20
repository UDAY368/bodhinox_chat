// GET /api/public/booking/<slug>/hold/<requestId>  the state of the hold this browser made.
// The booking page polls it while it waits for "BOOK <code>" on WhatsApp (and
// for the payment of a paid service). requestId is the client-generated UUID
// sent with the hold, so only that browser knows it. Answers only
// { status: held | payment_pending | confirmed | expired | cancelled } and,
// once confirmed, the manage path. A requestId from another page or
// workspace is the plain 404.

import {
  burstAllowed, HOLD_STATUS_LIMIT, inPublicTenant, isId, json, notFound, publicError, resolvePage, tooMany,
} from '../../../_lib/public';
import { loadHoldStatus } from '../../../_lib/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string; requestId: string }> };

export async function GET(request: Request, { params }: Params) {
  if (!burstAllowed('hold_status', request, HOLD_STATUS_LIMIT)) return tooMany();
  try {
    const { slug, requestId } = await params;
    if (!isId(requestId)) return notFound();
    const page = await resolvePage(slug);
    if (!page) return notFound();
    const view = await inPublicTenant(page.accountId, (tx) => loadHoldStatus(tx, page.accountId, page.pageId, requestId));
    return view ? json(view) : notFound();
  } catch (error) {
    return publicError(error, 'hold_status');
  }
}
