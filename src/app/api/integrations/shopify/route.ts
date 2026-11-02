// GET    /api/integrations/shopify — any member: { configured, store, rules, templates, fields }.
// PATCH  /api/integrations/shopify { marketing_opt_in_only } — admin.
// DELETE /api/integrations/shopify — admin: uninstalls the app from the store
//        and stops the Shopify rules. The row is kept (without its token) until
//        Shopify's shop/redact so the store's data can still be redacted.
// The access token is never returned: the app role cannot even read it.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { revokeAccess } from '@/lib/integrations/shopify/admin-api';
import { shopifyConfig } from '@/lib/integrations/shopify/config';
import { listRuleTemplates, listShopifyRules } from '@/lib/integrations/shopify/rules';
import { getShopifyStore, loadShopifyToken, setMarketingOptInOnly, stopShopifyStore, type ShopifyStorePublic } from '@/lib/integrations/shopify/store';
import { SHOPIFY_TEMPLATE_FIELDS } from '@/lib/integrations/shopify/webhooks';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };
const Patch = z.object({ marketing_opt_in_only: z.boolean() });

const storeDto = (s: ShopifyStorePublic | null) => s && {
  shop_domain: s.shop_domain,
  scopes: s.scopes,
  installed_at: s.installed_at.toISOString(),
  uninstalled_at: s.uninstalled_at?.toISOString() ?? null,
  marketing_opt_in_only: s.marketing_opt_in_only,
};

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const data = await withTenant(tenantOf(ctx), async (tx) => ({
      store: await getShopifyStore(tx, ctx.accountId),
      rules: await listShopifyRules(tx, ctx.accountId),
      templates: await listRuleTemplates(tx, ctx.accountId),
    }));
    return NextResponse.json({
      configured: shopifyConfig() !== null,
      store: storeDto(data.store),
      rules: data.rules,
      templates: data.templates,
      fields: SHOPIFY_TEMPLATE_FIELDS,
    }, { headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    if (!shopifyConfig()) return NextResponse.json({ error: 'not_configured' }, { status: 503, headers });
    const ctx = await requireRole('admin');
    const parsed = Patch.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers });
    const store = await withTenant(tenantOf(ctx), (tx) => setMarketingOptInOnly(tx, ctx.accountId, parsed.data.marketing_opt_in_only));
    if (!store) return NextResponse.json({ error: 'not_connected' }, { status: 404, headers });
    return NextResponse.json({ store: storeDto(store) }, { headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE() {
  try {
    if (!shopifyConfig()) return NextResponse.json({ error: 'not_configured' }, { status: 503, headers });
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`shopifyDisconnect:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const token = await loadShopifyToken(ctx.accountId);
    if (!token) return NextResponse.json({ error: 'not_connected' }, { status: 404, headers });
    // Uninstall on Shopify first; if Shopify cannot be reached the store stays connected and the admin retries.
    if (!(await revokeAccess(token))) return NextResponse.json({ error: 'shopify_unreachable' }, { status: 502, headers });
    // Stopping skips queued sends, which only the worker role may change; the admin check above authorises it.
    await withTenant({ accountId: ctx.accountId, role: 'owner' }, (tx) => stopShopifyStore(tx, ctx.accountId), getWorkerPrisma());
    const store = await withTenant(tenantOf(ctx), (tx) => getShopifyStore(tx, ctx.accountId));
    return NextResponse.json({ store: storeDto(store) }, { headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}
