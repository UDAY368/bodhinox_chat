// GET /api/commerce/shop/meta-link — variants matched to the Meta catalogue mirror by SKU = retailer_id, and what is
//   unmatched on each side (agents and above; read-only). 200 { linked, variants_without_meta, meta_without_variant }.
export const runtime = 'nodejs';

import { linkMetaProducts } from '@/lib/commerce/catalogue/products';
import { catalogueErrorResponse, inTenant, json, staffCaller } from '../_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'agent' });
    return json(await inTenant(caller, (tx) => linkMetaProducts(tx, caller.accountId)));
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
