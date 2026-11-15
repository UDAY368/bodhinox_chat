// GET  /api/commerce/shop/collections — every collection with the number of products a visitor would see (agents and above). 200 { collections }.
// POST /api/commerce/shop/collections { title, slug?, description?, kind?: 'manual'|'smart', rules?, match?: 'all'|'any',
//   sort?, published?, product_ids? } (admins). 201 { collection }. 409 slug_taken. A rule is { field, op, value } from a fixed list.
export const runtime = 'nodejs';

import { listCollections, upsertCollection } from '@/lib/commerce/catalogue/collections';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller } from '../_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'agent' });
    return json({ collections: await inTenant(caller, (tx) => listCollections(tx, caller.accountId)) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = await readJson(request);
    return json({ collection: await inTenant(caller, (tx) => upsertCollection(tx, caller.accountId, caller.userId, null, body)) }, 201);
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
