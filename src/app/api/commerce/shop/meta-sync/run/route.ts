// POST /api/commerce/shop/meta-sync/run (admins) — "Sync now": queues one full Meta catalogue sync run (at most one a minute
//      per workspace) before answering; it also sends failed items again. Uncertain items are never sent by it.
//      202 { queued: true }. 409 meta_not_connected / meta_sync_off.
export const runtime = 'nodejs';

import { requestMetaSync } from '@/lib/commerce/catalogue/meta-sync-job';
import { catalogueErrorResponse, json, mutationLimit, staffCaller } from '../../_lib/http';

export async function POST(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    await requestMetaSync({ ...caller.tenant, userId: caller.userId });
    return json({ queued: true }, 202);
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
