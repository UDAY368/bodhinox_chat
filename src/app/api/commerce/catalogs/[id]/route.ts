// GET    /api/commerce/catalogs/[id] — one linked catalogue (any member). 200 { catalog }; 404.
// PATCH  /api/commerce/catalogs/[id] { is_cart_enabled?, is_catalog_visible? } — change the number's cart and
//   catalogue switches on Meta, then store them (admin, rate limited). 200 { catalog }; 400; 404; 409; 502.
// DELETE /api/commerce/catalogs/[id] — unlink it here and drop its mirrored products; Meta is left as is
//   (admin, rate limited). 200 { ok: true }; 404.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { CatalogError, deleteCatalog, getCatalog, parseSettingsInput, updateCatalogSettings } from '@/lib/commerce/catalog';
import { catalogErrorResponse } from '@/lib/commerce/catalog-http';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('viewer');
    const catalog = await withTenant(tenantOf(ctx), (tx) => getCatalog(tx, ctx.accountId, id));
    if (!catalog) throw new CatalogError('not_found');
    return NextResponse.json({ catalog });
  } catch (error) {
    return catalogErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`catalogs:write:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const patch = parseSettingsInput(await request.json().catch(() => null));
    return NextResponse.json({ catalog: await updateCatalogSettings(tenantOf(ctx), id, patch) });
  } catch (error) {
    return catalogErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`catalogs:write:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const deleted = await withTenant(tenantOf(ctx), (tx) => deleteCatalog(tx, ctx.accountId, id));
    if (!deleted) throw new CatalogError('not_found');
    return NextResponse.json({ ok: true });
  } catch (error) {
    return catalogErrorResponse(error);
  }
}
