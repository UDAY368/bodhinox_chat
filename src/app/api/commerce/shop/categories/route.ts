// GET  /api/commerce/shop/categories — every category, archived last (agents and above). 200 { categories }.
// POST /api/commerce/shop/categories { name, parent_id?, position? } (admins). Depth at most two. 201 { category }.
export const runtime = 'nodejs';

import { createCategory, listCategories } from '@/lib/commerce/catalogue/products';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller } from '../_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'agent' });
    return json({ categories: await inTenant(caller, (tx) => listCategories(tx, caller.accountId)) });
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
    return json({ category: await inTenant(caller, (tx) => createCategory(tx, caller.accountId, caller.userId, body)) }, 201);
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
