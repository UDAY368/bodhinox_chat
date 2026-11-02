// GET /api/commerce/products?q=&availability=in_stock|out_of_stock|other&catalog_id=&whatsapp_config_id=&conversation_id=&hidden=1&limit=&offset=
//   Mirrored catalogue products by name (any member). 200 { products: [{ id, catalog_row_id, retailer_id, name,
//   description, price_minor, currency, image_url, url, availability, is_hidden, synced_at }], total }.
//   Prices are integer minor units; format them with lib/commerce/money.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { listProducts, parseProductQuery } from '@/lib/commerce/catalog';
import { catalogErrorResponse } from '@/lib/commerce/catalog-http';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const query = parseProductQuery(new URL(request.url).searchParams);
    return NextResponse.json(await withTenant(tenantOf(ctx), (tx) => listProducts(tx, ctx.accountId, query)));
  } catch (error) {
    return catalogErrorResponse(error);
  }
}
