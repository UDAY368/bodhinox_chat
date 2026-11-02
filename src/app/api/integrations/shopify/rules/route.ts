// PUT /api/integrations/shopify/rules { event, enabled, template_name,
// template_language, whatsapp_config_id, delay_minutes, variable_map } — admin.
// Creates or replaces the Shopify rule for one event. The template must be
// approved (and on the chosen number's WhatsApp Business account); variables map
// to the supported event fields only.

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { shopifyConfig } from '@/lib/integrations/shopify/config';
import { RuleBody, saveShopifyRule, ShopifyRuleError } from '@/lib/integrations/shopify/rules';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };

export async function PUT(request: Request) {
  try {
    if (!shopifyConfig()) return NextResponse.json({ error: 'not_configured' }, { status: 503, headers });
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`shopifyRules:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const parsed = RuleBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_rule' }, { status: 400, headers });
    try {
      const rule = await withTenant(tenantOf(ctx), (tx) => saveShopifyRule(tx, ctx.accountId, parsed.data));
      return NextResponse.json({ rule }, { headers });
    } catch (error) {
      if (error instanceof ShopifyRuleError) return NextResponse.json({ error: error.reason }, { status: 400, headers });
      throw error;
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
