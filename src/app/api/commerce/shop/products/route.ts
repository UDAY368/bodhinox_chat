// GET  /api/commerce/shop/products?q=&status=draft|published|archived|all&category_id=&stock=in_stock|low|out&limit=&offset=
//   The Bodhinox-owned catalogue (agents and above). 200 { products, total }. Prices are integer minor units.
// POST /api/commerce/shop/products { name, description?, disclosure?, category_id?, follow_up_template?,
//   follow_up_template_language?, follow_up_after_days?, repurchase_after_days?, images? } (admins). 201 { product } as a draft.
export const runtime = 'nodejs';

import { listShopProducts, parseShopProductQuery, upsertProduct } from '@/lib/commerce/catalogue/products';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller } from '../_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'agent' });
    const query = parseShopProductQuery(new URL(request.url).searchParams);
    return json(await inTenant(caller, (tx) => listShopProducts(tx, caller.accountId, query)));
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
    const product = await inTenant(caller, (tx) => upsertProduct(tx, caller.accountId, caller.userId, null, body));
    return json({ product }, 201);
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
