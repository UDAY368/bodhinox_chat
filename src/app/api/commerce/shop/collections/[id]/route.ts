// GET    /api/commerce/shop/collections/[id] — the collection with its picked products (agents and above). 200 { collection }.
// PATCH  /api/commerce/shop/collections/[id] { title?, slug?, description?, kind?, rules?, match?, sort?, published?, product_ids? } (admins). 200 { collection }.
// DELETE /api/commerce/shop/collections/[id] (admins). 200 { ok: true }. Another workspace's id is a 404.
export const runtime = 'nodejs';

import { deleteCollection, getCollection, upsertCollection } from '@/lib/commerce/catalogue/collections';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller, type IdContext } from '../../_lib/http';

export async function GET(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'agent' });
    return json({ collection: await inTenant(caller, (tx) => getCollection(tx, caller.accountId, id)) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = await readJson(request);
    return json({ collection: await inTenant(caller, (tx) => upsertCollection(tx, caller.accountId, caller.userId, id, body)) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    await inTenant(caller, (tx) => deleteCollection(tx, caller.accountId, caller.userId, id));
    return json({ ok: true });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
