// GET /api/commerce/shop/meta-sync — full Meta catalogue sync: whether a catalogue is connected, the opt-in, what it covers,
//     counts by status, failed and uncertain items (codes only) and each published product's status (agents and above).
// PUT /api/commerce/shop/meta-sync (admins) — { enabled?, scope?: 'all' | 'selected', select?: product id, deselect?: product id }.
//     Turning it on needs a linked catalogue (409 meta_not_connected). A sync run is queued in the same transaction. 200 { sync }.
export const runtime = 'nodejs';

import { getMetaSyncView, parseMetaSyncSettings, saveMetaSyncSettings } from '@/lib/commerce/catalogue/meta-sync-job';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller } from '../_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'agent' });
    return json({ sync: await inTenant(caller, (tx) => getMetaSyncView(tx, caller.accountId)) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const input = parseMetaSyncSettings(await readJson(request));
    return json({ sync: await saveMetaSyncSettings({ ...caller.tenant, userId: caller.userId }, input) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
