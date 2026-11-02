// GET  /api/commerce/catalogs — linked catalogues (any member).
//   200 { catalogs: [{ id, catalog_id, name, whatsapp_config_id, number_label, is_cart_enabled,
//         is_catalog_visible, last_synced_at, sync_error, created_at, product_count }] }
// GET  /api/commerce/catalogs?whatsapp_config_id=<uuid> — that number's WABA catalogues on Meta (admin, rate limited).
//   200 { available: [{ id, name, linked }] }; 409 number not connected or no WABA; 502 Meta failed.
// POST /api/commerce/catalogs { whatsapp_config_id, catalog_id, is_cart_enabled?, is_catalog_visible? } — link one
//   to a number, apply the cart and catalogue settings on Meta and queue the first sync (admin, rate limited).
//   201 { catalog }; 400 bad input; 409 number unavailable, catalogue not in the WABA, or the number has one; 502 Meta.
// Access tokens never leave the server.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { connectCatalog, listCatalogs, listMetaCatalogs, parseConnectInput } from '@/lib/commerce/catalog';
import { catalogErrorResponse } from '@/lib/commerce/catalog-http';

export async function GET(request: Request) {
  try {
    const configId = new URL(request.url).searchParams.get('whatsapp_config_id');
    if (configId !== null) {
      const ctx = await requireRole('admin');
      const limit = checkRateLimit(`catalogs:meta:${ctx.userId}`, RATE_LIMITS.adminAction);
      if (!limit.success) return rateLimitResponse(limit);
      return NextResponse.json({ available: await listMetaCatalogs(tenantOf(ctx), configId) });
    }
    const ctx = await requireRole('viewer');
    return NextResponse.json({ catalogs: await withTenant(tenantOf(ctx), (tx) => listCatalogs(tx, ctx.accountId)) });
  } catch (error) {
    return catalogErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`catalogs:write:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseConnectInput(await request.json().catch(() => null));
    return NextResponse.json({ catalog: await connectCatalog(tenantOf(ctx), input) }, { status: 201 });
  } catch (error) {
    return catalogErrorResponse(error);
  }
}
