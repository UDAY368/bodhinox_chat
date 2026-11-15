// POST /api/commerce/shop/collections/preview { kind, rules?, match?, product_ids? } (agents and above; nothing is saved).
//   200 { count, sample } — how many products a visitor would see and the first few names.
export const runtime = 'nodejs';

import { previewCollection } from '@/lib/commerce/catalogue/collections';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller } from '../../_lib/http';

export async function POST(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'agent', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = await readJson(request);
    return json(await inTenant(caller, (tx) => previewCollection(tx, caller.accountId, body)));
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
