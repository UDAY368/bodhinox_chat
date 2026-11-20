// GET  /api/commerce/shop/products?q=&status=draft|published|archived|all&category_id=&stock=in_stock|low|out&limit=&offset=
//   The Bodhinox-owned catalogue (agents and above). 200 { products, total }. Prices are integer minor units.
// POST /api/commerce/shop/products — the product form (admins): product fields, images, optional variants (the options matrix)
//   and bundle parts in one transaction; a default variant with a generated SKU when no variants are sent. 201 { product, stock_error? }.
export const runtime = 'nodejs';

import { listShopProducts, parseShopProductQuery } from '@/lib/commerce/catalogue/products';
import { saveProduct } from '../_lib/product-save';
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
    return json(await saveProduct(caller, null, body), 201);
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
